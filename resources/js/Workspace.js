import buddyIn from '../audio/buddy-in.mp3'
import buddyOut from '../audio/buddy-out.mp3'

export default class Workspace {

    constructor(container) {
        this.container = container;
        this.echo = null;
        this.started = false;
        this.storeSubscriber = null;
        this.lastValues = {};
        this.lastMetaValues = {};
        this.user = Statamic.user;
        this.initialStateUpdated = false;
        this.stateApiUrl = null;

        // Unique ID for this window/tab to distinguish from same user in other windows
        this.windowId = this.generateWindowId();

        // Track all active windows (not just users) for proper broadcast logic
        this.activeWindows = new Set();

        // Track which changes came from broadcasts (to avoid re-broadcasting)
        this.applyingBroadcast = false;

        // Inactivity tracking (12 hours = 43200000ms)
        this.inactivityTimeout = 12 * 60 * 60 * 1000;
        this.inactivityTimer = null;
        this.inactivityWarningShown = false;

        // Prevent concurrent loadCachedState calls
        this.loadingCachedState = false;

        // Track when we last made a local change (to avoid overwriting recent edits)
        this.lastLocalChangeTime = 0;
        this.localChangeProtectionMs = 3000; // Don't overwrite if changed within last 3 seconds

        this.debouncedBroadcastValueChangeFuncsByHandle = {};
        this.debouncedBroadcastMetaChangeFuncsByHandle = {};
        this.debouncedPersistValueFuncsByHandle = {};
        this.debouncedPersistMetaFuncsByHandle = {};

        // Toast notification flags (to avoid duplicate toasts)
        this.notSavedToastShown = false;
        this.unsavedToastShown = false;

        // Grace period after save (to avoid false "unsaved changes" from post-save mutations)
        this.lastSaveTime = 0;
        this.saveGracePeriodMs = 2000;
    }

    generateWindowId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    start() {
        if (this.started) return;

        this.initializeStateApi();
        this.initializeEcho();
        this.initializeStore();
        this.initializeFocus();
        this.initializeValuesAndMeta();
        this.initializeHooks();
        this.initializeStatusBar();
        this.initializeVisibilityHandler();
        this.initializeTypingIndicatorStyles();
        this.started = true;
    }

    initializeVisibilityHandler() {
        // Track the previous visibility state to avoid spurious events
        this.wasHidden = document.visibilityState === 'hidden';

        this.visibilityHandler = async () => {
            const isNowVisible = document.visibilityState === 'visible';
            const isNowHidden = document.visibilityState === 'hidden';

            if (isNowHidden) {
                this.wasHidden = true;
                this.debug('👁️ Window became hidden');
                return;
            }

            if (isNowVisible && this.wasHidden) {
                this.wasHidden = false;
                this.debug('👁️ Window became visible after being hidden, syncing state...');
                await this.loadCachedState('visibilityHandler');
                // Re-announce ourselves to get fresh state from other windows
                this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });
            } else if (isNowVisible) {
                this.debug('👁️ Visibility event fired but window was not hidden, skipping sync');
            }
        };

        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    initializeTypingIndicatorStyles() {
        // Create a style element for typing indicator animations
        this.typingStyleElement = document.createElement('style');
        this.typingStyleElement.id = `collaboration-typing-${this.channelName.replace(/\./g, '-')}`;
        document.head.appendChild(this.typingStyleElement);

        // Base styles for typing animation
        this.typingStyleElement.textContent = `
            @keyframes collaboration-typing-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                50% { box-shadow: 0 0 0 4px rgba(34, 197, 94, 0); }
            }
            .collaboration-typing-indicator {
                animation: collaboration-typing-pulse 1.5s infinite;
            }
        `;
    }

    updateTypingIndicators() {
        const typing = Statamic.$store.state.collaboration[this.channelName]?.typing || {};
        const handles = Object.values(typing).map(t => t.handle).filter(Boolean);

        // Find and update field elements
        document.querySelectorAll('.publish-field').forEach(field => {
            const handle = field.dataset.handle || field.querySelector('[data-handle]')?.dataset.handle;
            const avatar = field.querySelector('.read-only-field .avatar, .publish-field-lock .avatar');

            if (avatar) {
                if (handles.includes(handle)) {
                    avatar.classList.add('collaboration-typing-indicator');
                } else {
                    avatar.classList.remove('collaboration-typing-indicator');
                }
            }
        });
    }

    initializeStateApi() {
        const reference = this.container.reference.replaceAll('::', '.');
        const site = this.container.site.replaceAll('.', '_');
        const cpUrl = Statamic.$config.get('cpUrl') || '/cp';
        this.stateApiUrl = `${cpUrl}/collaboration/state/${reference}/${site}`;
    }

    destroy() {
        // Clear inactivity timer
        this.clearActivityTimer();

        // Remove visibility handler
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
        }

        // Remove typing indicator styles
        if (this.typingStyleElement) {
            this.typingStyleElement.remove();
        }

        // Announce that this window is leaving
        this.channel.whisper('window-left', { windowId: this.windowId });

        // Remove ourselves from active windows
        this.activeWindows.delete(this.windowId);

        // State is not cleared here - it expires after 24 hours of inactivity via server TTL

        this.storeSubscriber.apply();
        this.echo.leave(this.channelName);
    }

    initializeEcho() {
        const reference = this.container.reference.replaceAll('::', '.');
        this.channelName = `${reference}.${this.container.site.replaceAll('.', '_')}`;
        this.channel = this.echo.join(this.channelName);

        // Monitor connection status
        this.initializeConnectionMonitoring();

        this.channel.here(async users => {
            this.subscribeToVuexMutations();
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);

            // Register our own window
            this.activeWindows.add(this.windowId);

            // Start inactivity timer
            this.resetActivityTimer();

            // Always load cached state first (handles reconnects and stale data)
            await this.loadCachedState('channel.here');

            // Announce our window to others (they will respond with window-present and fresh state)
            this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });
        });

        // Listen for other windows joining (use direct listener, no chunking needed)
        this.channel.listenForWhisper('window-joined', ({ windowId, user }) => {
            if (windowId === this.windowId) return;

            this.debug(`Window joined: ${windowId}`, { user });
            this.activeWindows.add(windowId);

            // Respond so the new window knows about us
            this.channel.whisper('window-present', { windowId: this.windowId, user: this.user });

            // Send current state to the new window
            this.channel.whisper(`initialize-state-for-window-${windowId}`, {
                values: Statamic.$store.state.publish[this.container.name].values,
                meta: this.cleanEntireMetaPayload(Statamic.$store.state.publish[this.container.name].meta),
                focus: Statamic.$store.state.collaboration[this.channelName].focus,
                fromWindowId: this.windowId,
            });
        });

        // Listen for existing windows announcing themselves (use direct listener)
        this.channel.listenForWhisper('window-present', ({ windowId, user }) => {
            if (windowId === this.windowId) return;

            this.debug(`Window present: ${windowId}`, { user });
            this.activeWindows.add(windowId);
        });

        // Listen for windows leaving (use direct listener)
        this.channel.listenForWhisper('window-left', ({ windowId }) => {
            this.debug(`Window left: ${windowId}`);
            this.activeWindows.delete(windowId);
        });

        // Listen for initial state from other windows (targeted to our windowId)
        // This always merges state since other windows may have fresher data than cached state
        this.channel.listenForWhisper(`initialize-state-for-window-${this.windowId}`, async payload => {
            this.debug('✅ Applying/merging state from another window', payload);

            // Mark that we're applying external data to prevent re-broadcasting
            this.applyingBroadcast = true;
            try {
                // Merge values with current state
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...payload.values };
                await Statamic.$store.dispatch(`publish/${this.container.name}/setValues`, mergedValues);

                // Merge meta with current state
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const restoredMeta = this.restoreEntireMetaPayload(payload.meta);
                const mergedMeta = { ...currentMeta };
                Object.keys(restoredMeta).forEach(handle => {
                    mergedMeta[handle] = { ...currentMeta[handle], ...restoredMeta[handle] };
                });
                await Statamic.$store.dispatch(`publish/${this.container.name}/setMeta`, mergedMeta);
            } finally {
                this.applyingBroadcast = false;
            }

            // Apply focus locks from other windows
            _.each(payload.focus, ({ user, handle }) => {
                if (user.id !== this.user.id) {
                    this.focusAndLock(user, handle);
                }
            });

            this.initialStateUpdated = true;
        });

        this.channel.joining(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/addUser`, user);

            // Only show toast and play sound for OTHER users (not our own other windows)
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has joined.`, { duration: 2000 });
                if (Statamic.$config.get('collaboration.sound_effects')) {
                    this.playAudio('buddy-in');
                }
            }
            // Note: State initialization is now handled via window-joined/window-present whispers
        });

        this.channel.leaving(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/removeUser`, user);

            // Only show toast and play sound for OTHER users (not our own other windows)
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has left.`, { duration: 2000 });
                if (Statamic.$config.get('collaboration.sound_effects')) {
                    this.playAudio('buddy-out');
                }
            }

            this.blurAndUnlock(user);
        });

        this.listenForWhisper('updated', e => {
            this.applyBroadcastedValueChange(e);
        });

        // Handle large payloads - fetch from server instead of receiving via WebSocket
        this.channel.listenForWhisper('fetch-field', ({ handle, type, windowId }) => {
            this.debug(`📥 Received fetch-field from ${windowId?.slice(-6)}, my windowId: ${this.windowId?.slice(-6)}`);
            if (windowId === this.windowId) {
                this.debug(`📥 Skipping own fetch-field`);
                return;
            }

            this.debug(`📥 Fetching ${type} for "${handle}" from server (large payload)`);
            this.loadCachedState('fetch-field listener'); // Reload all state from server
        });

        this.listenForWhisper('meta-updated', e => {
            this.applyBroadcastedMetaChange(e);
        });

        this.listenForWhisper('focus', ({ user, handle, windowId }) => {
            // Ignore focus events from our own other windows
            if (windowId === this.windowId) return;

            this.debug(`Heard that user has changed focus`, { user, handle, windowId });

            // Don't lock fields for our own other windows - only for other users
            if (user.id === this.user.id) {
                this.focus(user, handle);
            } else {
                this.focusAndLock(user, handle);
                // Show toast that another user is editing this field
                const fieldName = this.formatFieldName(handle);
                Statamic.$toast.info(`${fieldName} is being edited by ${user.name}.`, { duration: 2000 });
            }
        });

        this.listenForWhisper('blur', ({ user, handle, windowId }) => {
            // Ignore blur events from our own other windows
            if (windowId === this.windowId) return;

            this.debug(`Heard that user has blurred`, { user, handle, windowId });

            // Don't unlock fields for our own other windows - only for other users
            if (user.id === this.user.id) {
                this.blur(user);
            } else {
                this.blurAndUnlock(user, handle);
                // Show toast that another user finished editing
                if (handle) {
                    const fieldName = this.formatFieldName(handle);
                    Statamic.$toast.success(`${fieldName} is no longer being edited by ${user.name}.`, { duration: 2000 });
                }
            }
        });

        this.listenForWhisper('force-unlock', ({ targetUser, originUser }) => {
            this.debug(`Heard that user has requested another be unlocked`, { targetUser, originUser });

            if (targetUser.id !== this.user.id) return;

            document.activeElement.blur();
            this.blurAndUnlock(this.user);
            this.whisper('blur', { user: this.user });
            Statamic.$toast.info(`${originUser.name} has unlocked your editor.`, { duration: false });
        });

        this.listenForWhisper('saved', ({ user, windowId }) => {
            // Ignore if this is our own save action
            if (windowId === this.windowId) return;

            // Mark save time to prevent false "unsaved changes" from post-save mutations
            this.lastSaveTime = Date.now();

            // Update save status and original values since another window saved
            const currentValues = Statamic.$store.state.publish[this.container.name].values;
            Statamic.$store.commit(`collaboration/${this.channelName}/setOriginalValues`, clone(currentValues));
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');

            // Reset toast flags
            this.unsavedToastShown = false;
            this.notSavedToastShown = false;

            Statamic.$toast.success(`Saved by ${user.name}.`);
        });

        this.listenForWhisper('published', ({ user, message, windowId }) => {
            // Ignore if this is our own publish action
            if (windowId === this.windowId) return;

            Statamic.$toast.success(`Published by ${user.name}.`);
            const messageProp = message
                ? `Entry has been published by ${user.name} with the message: ${message}`
                : `Entry has been published by ${user.name} with no message.`
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: messageProp }
            }).on('confirm', () => window.location.reload());
            this.destroy(); // Stop listening to anything else.
        });

        this.listenForWhisper('revision-restored', ({ user, windowId }) => {
            // Ignore if this is our own restore action
            if (windowId === this.windowId) return;

            Statamic.$toast.success(`Revision restored by ${user.name}.`);
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: `Entry has been restored to another revision by ${user.name}` }
            }).on('confirm', () => window.location.reload());
            this.destroy(); // Stop listening to anything else.
        });

        // Listen for typing indicators
        this.listenForWhisper('typing', ({ user, handle, windowId }) => {
            if (windowId === this.windowId) return;
            if (user.id === this.user.id) return;

            Statamic.$store.commit(`collaboration/${this.channelName}/setTyping`, { user, handle });
            this.updateTypingIndicators();

            // Auto-clear typing indicator after 3 seconds of no updates
            if (this.typingTimeouts && this.typingTimeouts[user.id]) {
                clearTimeout(this.typingTimeouts[user.id]);
            }
            if (!this.typingTimeouts) this.typingTimeouts = {};
            this.typingTimeouts[user.id] = setTimeout(() => {
                Statamic.$store.commit(`collaboration/${this.channelName}/clearTyping`, user);
                this.updateTypingIndicators();
            }, 3000);
        });

        this.listenForWhisper('stopped-typing', ({ user, windowId }) => {
            if (windowId === this.windowId) return;
            if (user.id === this.user.id) return;

            Statamic.$store.commit(`collaboration/${this.channelName}/clearTyping`, user);
            this.updateTypingIndicators();
        });
    }

    initializeConnectionMonitoring() {
        // Get the underlying Pusher/Socket connection
        const connector = this.echo?.connector;

        if (!connector) {
            this.debug('⚠️ Connection monitoring not available - no connector');
            return;
        }

        if (connector.pusher) {
            // Pusher-based connection (Pusher, Reverb, Soketi, etc.)
            const pusher = connector.pusher;

            pusher.connection.bind('connecting', () => {
                this.debug('🔄 Connection: connecting...');
                Statamic.$store.commit(`collaboration/${this.channelName}/setConnectionStatus`, 'reconnecting');
            });

            pusher.connection.bind('connected', () => {
                this.debug('✅ Connection: connected');
                const wasDisconnected = Statamic.$store.state.collaboration[this.channelName]?.connectionStatus !== 'connected';
                Statamic.$store.commit(`collaboration/${this.channelName}/setConnectionStatus`, 'connected');

                if (wasDisconnected) {
                    Statamic.$toast.success('Connection restored.', { duration: 2000 });
                    // Reload state after reconnection
                    this.loadCachedState('reconnected');
                }
            });

            pusher.connection.bind('disconnected', () => {
                this.debug('❌ Connection: disconnected');
                Statamic.$store.commit(`collaboration/${this.channelName}/setConnectionStatus`, 'disconnected');
                Statamic.$toast.error('Connection lost. Trying to reconnect...', { duration: false });
            });

            pusher.connection.bind('unavailable', () => {
                this.debug('⚠️ Connection: unavailable');
                Statamic.$store.commit(`collaboration/${this.channelName}/setConnectionStatus`, 'disconnected');
            });

            pusher.connection.bind('failed', () => {
                this.debug('💀 Connection: failed');
                Statamic.$store.commit(`collaboration/${this.channelName}/setConnectionStatus`, 'disconnected');
                Statamic.$toast.error('Connection failed. Please refresh the page.', { duration: false });
            });
        }
    }

    initializeStore() {
        // Detect if this is a new entry (not yet saved)
        // New entries typically have 'create' in the reference or no valid ID
        const isNewEntry = this.container.reference.includes('create') ||
                          !this.container.reference.match(/[a-f0-9-]{36}$/i);

        Statamic.$store.registerModule(['collaboration', this.channelName], {
            namespaced: true,
            state: {
                users: [],
                focus: {},
                // Save status: 'notSaved' (new), 'saved' (no changes), 'changesNotSaved' (has changes)
                saveStatus: isNewEntry ? 'notSaved' : 'saved',
                // Store original values to detect changes
                originalValues: null,
                // Connection status: 'connected', 'disconnected', 'reconnecting'
                connectionStatus: 'connected',
                // Track which users are actively typing (userId -> { handle, timestamp })
                typing: {},
            },
            mutations: {
                setUsers(state, users) {
                    state.users = users;
                },
                addUser(state, user) {
                    state.users.push(user);
                },
                removeUser(state, removedUser) {
                    state.users = state.users.filter(user => user.id !== removedUser.id);
                },
                focus(state, { handle, user }) {
                    Vue.set(state.focus, user.id, { handle, user });
                },
                blur(state, user) {
                    Vue.delete(state.focus, user.id);
                },
                setSaveStatus(state, status) {
                    state.saveStatus = status;
                },
                setOriginalValues(state, values) {
                    state.originalValues = values;
                },
                setConnectionStatus(state, status) {
                    state.connectionStatus = status;
                },
                setTyping(state, { user, handle }) {
                    Vue.set(state.typing, user.id, { handle, user, timestamp: Date.now() });
                },
                clearTyping(state, user) {
                    Vue.delete(state.typing, user.id);
                }
            }
        });
    }

    initializeStatusBar() {
        const component = this.container.pushComponent('CollaborationStatusBar', {
            props: {
                channelName: this.channelName,
                connecting: this.connecting,
            }
        });

        component.on('unlock', (targetUser) => {
            this.whisper('force-unlock', { targetUser, originUser: this.user });
        });
    }

    initializeHooks() {
        Statamic.$hooks.on('entry.saved', (resolve, reject, { reference }) => {
            if (reference === this.container.reference) {
                // Mark save time to prevent false "unsaved changes" from post-save mutations
                this.lastSaveTime = Date.now();

                // Update save status to 'saved' and store new original values
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                Statamic.$store.commit(`collaboration/${this.channelName}/setOriginalValues`, clone(currentValues));
                Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');

                // Reset toast flags
                this.unsavedToastShown = false;
                this.notSavedToastShown = false;

                // Clear cached state from server
                this.clearCachedState();

                // Force whisper to notify all windows (including own other windows)
                this.whisper('saved', { user: this.user, windowId: this.windowId }, { force: true });
            }
            resolve();
        });

        Statamic.$hooks.on('entry.published', (resolve, reject, { reference, message }) => {
            if (reference === this.container.reference) {
                // Force whisper to notify all windows (including own other windows)
                this.whisper('published', { user: this.user, message, windowId: this.windowId }, { force: true });
            }
            resolve();
        });

        Statamic.$hooks.on('revision.restored', (resolve, reject, { reference }) => {
            if (reference !== this.container.reference) return resolve();

            // Force whisper to notify all windows (including own other windows)
            this.whisper('revision-restored', { user: this.user, windowId: this.windowId }, { force: true });

            // Echo doesn't give us a promise, so wait half a second before resolving.
            // That should be enough time for the whisper to be sent before the the page refreshes.
            setTimeout(resolve, 500);
        });
    }

    initializeFocus() {
        this.container.$on('focus', handle => {
            const user = this.user;
            this.focus(user, handle);
            this.whisper('focus', { user, handle, windowId: this.windowId });
        });
        this.container.$on('blur', handle => {
            const user = this.user;
            this.blur(user, handle);
            this.whisper('blur', { user, handle, windowId: this.windowId });
            this.whisper('stopped-typing', { user, windowId: this.windowId });
        });
    }

    focus(user, handle) {
        Statamic.$store.commit(`collaboration/${this.channelName}/focus`, { user, handle });
    }

    focusAndLock(user, handle) {
        this.focus(user, handle);
        Statamic.$store.commit(`publish/${this.container.name}/lockField`, { user, handle });
    }

    blur(user) {
        Statamic.$store.commit(`collaboration/${this.channelName}/blur`, user);
    }

    blurAndUnlock(user, handle = null) {
        handle = handle || data_get(Statamic.$store.state.collaboration[this.channelName], `focus.${user.id}.handle`);
        if (!handle) return;
        this.blur(user);
        Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
    }

    subscribeToVuexMutations() {
        this.storeSubscriber = Statamic.$store.subscribe((mutation, state) => {
            switch (mutation.type) {
                case `publish/${this.container.name}/setFieldValue`:
                    this.vuexFieldValueHasBeenSet(mutation.payload);
                    break;
                case `publish/${this.container.name}/setFieldMeta`:
                    this.vuexFieldMetaHasBeenSet(mutation.payload);
                    break;
            }
        });
    }

    // A field's value has been set in the vuex store.
    // It could have been triggered by the current user editing something,
    // or by the workspace applying a change dispatched by another user editing something.
    vuexFieldValueHasBeenSet(payload) {
        const valuePreview = typeof payload.value === 'string'
            ? payload.value.slice(-50)
            : JSON.stringify(payload.value).slice(-50);
        this.debug('Vuex field value has been set', {
            handle: payload.handle,
            user: payload.user,
            applyingBroadcast: this.applyingBroadcast,
            valueEnd: valuePreview
        });
        if (!this.valueHasChanged(payload.handle, payload.value)) {
            // No change? Don't bother doing anything.
            this.debug(`Value for ${payload.handle} has not changed.`);
            return;
        }

        this.rememberValueChange(payload.handle, payload.value);

        // Update save status based on whether values differ from original
        this.updateSaveStatus();

        // Reset inactivity timer on any change
        this.resetActivityTimer();

        // Only broadcast and persist if this change originated from THIS window
        if (!this.applyingBroadcast) {
            // Track when we made this local change
            this.lastLocalChangeTime = Date.now();

            // Check for conflict - is someone else typing on this field?
            this.checkForConflict(payload.handle);

            // Send typing indicator
            this.whisper('typing', { user: this.user, handle: payload.handle, windowId: this.windowId });

            this.debug(`📤 Will broadcast change for ${payload.handle}`);
            this.debouncedBroadcastValueChangeFuncByHandle(payload.handle)(payload);

            // Persist to server cache (only for our own changes from this window)
            if (this.user.id == payload.user) {
                this.persistValueChange(payload.handle, payload.value);
            }
        } else {
            this.debug(`🚫 Not broadcasting - applyingBroadcast is true`);
        }
    }

    checkForConflict(handle) {
        const typing = Statamic.$store.state.collaboration[this.channelName]?.typing || {};

        // Find if someone else is typing on this field
        for (const userId in typing) {
            const typingInfo = typing[userId];
            if (typingInfo.handle === handle && userId !== this.user.id) {
                // Check if the typing indicator is recent (within last 3 seconds)
                const isRecent = Date.now() - typingInfo.timestamp < 3000;
                if (isRecent && !this.conflictWarningShown?.[handle]) {
                    // Show conflict warning
                    const fieldName = this.formatFieldName(handle);
                    Statamic.$toast.error(
                        `${typingInfo.user.name} is also editing ${fieldName}. Your changes may overwrite theirs.`,
                        { duration: 4000 }
                    );
                    // Track that we've shown this warning to avoid spam
                    if (!this.conflictWarningShown) this.conflictWarningShown = {};
                    this.conflictWarningShown[handle] = true;
                    // Reset warning flag after 10 seconds
                    setTimeout(() => {
                        if (this.conflictWarningShown) {
                            delete this.conflictWarningShown[handle];
                        }
                    }, 10000);
                }
            }
        }
    }

    // A field's meta value has been set in the vuex store.
    // It could have been triggered by the current user editing something,
    // or by the workspace applying a change dispatched by another user editing something.
    vuexFieldMetaHasBeenSet(payload) {
        this.debug('Vuex field meta has been set', payload);
        if (!this.metaHasChanged(payload.handle, payload.value)) {
            // No change? Don't bother doing anything.
            this.debug(`Meta for ${payload.handle} has not changed.`, { value: payload.value, lastValue: this.lastMetaValues[payload.handle] });
            return;
        }

        this.rememberMetaChange(payload.handle, payload.value);

        // Reset inactivity timer on any change
        this.resetActivityTimer();

        // Only broadcast and persist if this change originated from THIS window
        if (!this.applyingBroadcast) {
            this.debouncedBroadcastMetaChangeFuncByHandle(payload.handle)(payload);

            // Persist to server cache (only for our own changes from this window)
            if (this.user.id == payload.user) {
                this.persistMetaChange(payload.handle, payload.value);
            }
        }
    }

    rememberValueChange(handle, value) {
        this.debug('Remembering value change', { handle, value });
        this.lastValues[handle] = clone(value);
    }

    rememberMetaChange(handle, value) {
        this.debug('Remembering meta change', { handle, value });
        this.lastMetaValues[handle] = clone(value);
    }

    debouncedBroadcastValueChangeFuncByHandle(handle) {
        // use existing debounced function if one already exists
        const func = this.debouncedBroadcastValueChangeFuncsByHandle[handle];
        if (func) return func;

        // if the handle has no debounced broadcast function yet, create one and return it
        this.debouncedBroadcastValueChangeFuncsByHandle[handle] = _.debounce((payload) => {
            this.broadcastValueChange(payload);
        }, 500);
        return this.debouncedBroadcastValueChangeFuncsByHandle[handle];
    }

    debouncedBroadcastMetaChangeFuncByHandle(handle) {
        // use existing debounced function if one already exists
        const func = this.debouncedBroadcastMetaChangeFuncsByHandle[handle];
        if (func) return func;

        // if the handle has no debounced broadcast function yet, create one and return it
        this.debouncedBroadcastMetaChangeFuncsByHandle[handle] = _.debounce((payload) => {
            this.broadcastMetaChange(payload);
        }, 500);
        return this.debouncedBroadcastMetaChangeFuncsByHandle[handle];
    }

    valueHasChanged(handle, newValue) {
        const lastValue = this.lastValues[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    metaHasChanged(handle, newValue) {
        const lastValue = this.lastMetaValues[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    updateSaveStatus() {
        // Skip if we just saved (grace period to avoid false positives from post-save mutations)
        const timeSinceSave = Date.now() - this.lastSaveTime;
        if (timeSinceSave < this.saveGracePeriodMs) {
            this.debug(`⏳ Skipping updateSaveStatus - within grace period (${timeSinceSave}ms since save)`);
            return;
        }

        const state = Statamic.$store.state.collaboration[this.channelName];
        const currentStatus = state.saveStatus;

        // If it's a new entry that was never saved, show toast once
        if (currentStatus === 'notSaved' && !this.notSavedToastShown) {
            this.notSavedToastShown = true;
            Statamic.$toast.info('New entry — changes stored temporarily for 12 hours.');
            return;
        }

        // Compare current values with original values
        const currentValues = Statamic.$store.state.publish[this.container.name].values;
        const originalValues = state.originalValues;

        if (!originalValues) {
            return;
        }

        const hasChanges = JSON.stringify(currentValues) !== JSON.stringify(originalValues);

        if (hasChanges && currentStatus !== 'changesNotSaved') {
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'changesNotSaved');
            this.debug('📝 Save status changed to: changesNotSaved');
            // Show toast for unsaved changes (only once per "dirty" state)
            if (!this.unsavedToastShown) {
                this.unsavedToastShown = true;
                Statamic.$toast.info('Unsaved changes — stored temporarily for 12 hours.');
            }
        } else if (!hasChanges && currentStatus !== 'saved') {
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');
            this.debug('📝 Save status changed to: saved');
            // Reset toast flag so it can show again next time
            this.unsavedToastShown = false;
        }
    }

    async broadcastValueChange(payload) {
        // Only broadcast if this change originated from THIS window (not from a broadcast we received)
        if (this.applyingBroadcast) {
            this.debug(`🚫 Skipping broadcast - applyingBroadcast is true`);
            return { largePayload: false };
        }

        // Only my own change events should be broadcasted
        if (this.user.id == payload.user) {
            const fullPayload = { ...payload, windowId: this.windowId };

            // For large payloads (>3KB), persist immediately and notify others to fetch from server
            if (JSON.stringify(fullPayload).length > 3000) {
                this.debug(`📦 Large payload for "${payload.handle}", persisting and sending fetch notification`);
                // Wait for persist to complete before notifying others to fetch
                await this.sendStateUpdate(payload.handle, payload.value, 'value');
                this.channel.whisper('fetch-field', { handle: payload.handle, type: 'value', windowId: this.windowId });
                return { largePayload: true }; // Signal that we already persisted
            } else {
                this.whisper('updated', fullPayload);
            }
        }
        return { largePayload: false };
    }

    async broadcastMetaChange(payload) {
        // Only broadcast if this change originated from THIS window (not from a broadcast we received)
        if (this.applyingBroadcast) return;

        // Only my own change events should be broadcasted
        if (this.user.id == payload.user) {
            const cleanedPayload = { ...this.cleanMetaPayload(payload), windowId: this.windowId };

            // For large payloads (>3KB), persist immediately and notify others to fetch from server
            if (JSON.stringify(cleanedPayload).length > 3000) {
                this.debug(`📦 Large meta payload for "${payload.handle}", persisting and sending fetch notification`);
                // Wait for persist to complete before notifying others to fetch
                await this.sendStateUpdate(payload.handle, payload.value, 'meta');
                this.channel.whisper('fetch-field', { handle: payload.handle, type: 'meta', windowId: this.windowId });
            } else {
                this.whisper('meta-updated', cleanedPayload);
            }
        }
    }

    // Allow fieldtypes to provide an array of keys that will be broadcasted.
    // For example, in Bard, only the "existing" value in its meta object
    // ever gets updated. We'll just broadcast that, rather than the
    // whole thing, which would be wasted bytes in the message.
    cleanMetaPayload(payload) {
        const allowed = data_get(payload, 'value.__collaboration');
        if (! allowed) return payload;
        let allowedValues = {};
        allowed.forEach(key => allowedValues[key] = payload.value[key]);
        payload.value = allowedValues;
        return payload;
    }

    // Similar to cleanMetaPayload, except for when dealing with the
    // entire list of fields' meta values. Used when a user joins
    // and needs to receive everything in one fell swoop.
    cleanEntireMetaPayload(values) {
        return _.mapObject(values, meta => {
            const allowed = data_get(meta, '__collaboration');
            if (!allowed) return meta;
            let allowedValues = {};
            allowed.forEach(key => allowedValues[key] = meta[key]);
            return allowedValues;
        });
    }

    restoreEntireMetaPayload(payload) {
        return _.mapObject(payload, (value, key) => {
            return {...this.lastMetaValues[key], ...value};
        });
    }

    formatFieldName(handle) {
        if (!handle) return 'Field';
        // Convert handle like "my_field_name" or "myFieldName" to "My field name"
        return handle
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, str => str.toUpperCase());
    }

    async applyBroadcastedValueChange(payload) {
        // Ignore broadcasts from this same window
        if (payload.windowId === this.windowId) return;

        this.debug('✅ Applying broadcasted value change', payload);

        // Mark that we're applying a broadcast to prevent re-broadcasting
        this.applyingBroadcast = true;
        try {
            await Statamic.$store.dispatch(`publish/${this.container.name}/setFieldValue`, payload);
        } finally {
            this.applyingBroadcast = false;
        }
    }

    async applyBroadcastedMetaChange(payload) {
        // Ignore broadcasts from this same window
        if (payload.windowId === this.windowId) return;

        this.debug('✅ Applying broadcasted meta change', payload);

        let value = {...this.lastMetaValues[payload.handle], ...payload.value};
        payload.value = value;

        // Mark that we're applying a broadcast to prevent re-broadcasting
        this.applyingBroadcast = true;
        try {
            await Statamic.$store.dispatch(`publish/${this.container.name}/setFieldMeta`, payload);
        } finally {
            this.applyingBroadcast = false;
        }
    }

    debug(message, args) {
        if (!Statamic.$config.get('collaboration.debug')) return;
        console.log(`[Collaboration ${this.windowId?.slice(-6) || 'init'}]`, message, {...args});
    }

    isAlone() {
        // Check if this is the only window (not just the only user)
        // Also check users from presence channel as fallback
        const users = Statamic.$store.state.collaboration[this.channelName]?.users || [];
        const multipleUsers = users.length > 1;
        const multipleWindows = this.activeWindows.size > 1;

        // Not alone if multiple users OR multiple windows
        const alone = !multipleUsers && !multipleWindows;

        this.debug(`isAlone check: users=${users.length}, activeWindows=${this.activeWindows.size}, alone=${alone}`);
        return alone;
    }

    whisper(event, payload, { force = false } = {}) {
        // Skip if alone, unless forced (for save/publish notifications to own windows)
        if (!force && this.isAlone()) return;

        const chunkSize = 2500;
        const str = JSON.stringify(payload);
        const msgId = Math.random() + '';

        if (str.length < chunkSize) {
            this.debug(`📣 Broadcasting "${event}"`, payload);
            this.channel.whisper(event, payload);
            return;
        }

        event = `chunked-${event}`;

        for (let i = 0; i * chunkSize < str.length; i++) {
            const chunk = {
                id: msgId,
                index: i,
                chunk: str.substr(i * chunkSize, chunkSize),
                final: chunkSize * (i + 1) >= str.length
            };
            this.debug(`📣 Broadcasting "${event}"`, chunk);
            this.channel.whisper(event, chunk);
        }
    }

    listenForWhisper(event, callback) {
        this.channel.listenForWhisper(event, callback);

        let events = {};
        this.channel.listenForWhisper(`chunked-${event}`, data => {
            if (! events.hasOwnProperty(data.id)) {
                events[data.id] = { chunks: [], receivedFinal: false };
            }

            let e = events[data.id];
            e.chunks[data.index] = data.chunk;
            if (data.final) e.receivedFinal = true;
            if (e.receivedFinal && e.chunks.length === Object.keys(e.chunks).length) {
                callback(JSON.parse(e.chunks.join('')));
                delete events[data.id];
            }
        });
    }

    playAudio(file) {
        let el = document.createElement('audio');
        el.src = this.getViteAudioFile(file);
        document.body.appendChild(el);
        el.volume = 0.25;
        el.addEventListener('ended', () => el.remove());
        el.play();
    }

    getViteAudioFile(file) {
        if (file === 'buddy-in') {
            return buddyIn;
        } else if (file === 'buddy-out') {
            return buddyOut;
        }

        console.error('audio not found');
    }

    initializeValuesAndMeta() {
        this.lastValues = clone(Statamic.$store.state.publish[this.container.name].values);
        this.lastMetaValues = clone(Statamic.$store.state.publish[this.container.name].meta);

        // Store original values to detect changes later
        Statamic.$store.commit(
            `collaboration/${this.channelName}/setOriginalValues`,
            clone(this.lastValues)
        );
    }

    cancelPendingBroadcasts() {
        // Cancel all pending debounced broadcast functions
        Object.values(this.debouncedBroadcastValueChangeFuncsByHandle).forEach(func => {
            if (func && typeof func.cancel === 'function') {
                func.cancel();
            }
        });
        Object.values(this.debouncedBroadcastMetaChangeFuncsByHandle).forEach(func => {
            if (func && typeof func.cancel === 'function') {
                func.cancel();
            }
        });
        this.debug('🚫 Cancelled pending debounced broadcasts');
    }

    async loadCachedState(source = 'unknown') {
        // Prevent concurrent loadCachedState calls
        if (this.loadingCachedState) {
            this.debug(`🔄 loadCachedState already in progress, skipping call from: ${source}`);
            return;
        }

        // Don't overwrite if user has made recent local changes (protects against losing typing)
        const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
        if (source === 'fetch-field listener' && timeSinceLastChange < this.localChangeProtectionMs) {
            this.debug(`🛡️ Skipping loadCachedState - local change was ${timeSinceLastChange}ms ago (protection: ${this.localChangeProtectionMs}ms)`);
            return;
        }

        this.loadingCachedState = true;
        this.debug(`🔄 loadCachedState called from: ${source}`);

        // Cancel any pending debounced broadcasts to prevent them from firing during fetch
        this.cancelPendingBroadcasts();

        // Set applyingBroadcast BEFORE fetch to prevent any broadcasts during the entire operation
        this.debug('🔒 Setting applyingBroadcast = true (before fetch)');
        this.applyingBroadcast = true;

        try {
            const response = await fetch(this.stateApiUrl, {
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
            });

            if (!response.ok) return;

            const data = await response.json();

            if (!data.exists) {
                this.debug('No cached state found');
                return;
            }

            this.debug('✅ Applying cached state from server', data);

            // Apply cached values - merge with current values
            if (data.values && Object.keys(data.values).length > 0) {
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...data.values };
                this.debug('📝 Dispatching setValues...');
                await Statamic.$store.dispatch(`publish/${this.container.name}/setValues`, mergedValues);
                this.debug('📝 setValues dispatch completed');
            }

            // Apply cached meta - merge with current meta
            if (data.meta && Object.keys(data.meta).length > 0) {
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const mergedMeta = { ...currentMeta };
                Object.keys(data.meta).forEach(handle => {
                    mergedMeta[handle] = { ...currentMeta[handle], ...data.meta[handle] };
                });
                await Statamic.$store.dispatch(`publish/${this.container.name}/setMeta`, mergedMeta);
            }

            this.initialStateUpdated = true;
        } catch (error) {
            this.debug('Failed to load cached state', { error });
        } finally {
            this.debug('🔓 Setting applyingBroadcast = false');
            this.applyingBroadcast = false;
            this.loadingCachedState = false;
        }
    }

    persistValueChange(handle, value) {
        this.debouncedPersistValueFuncByHandle(handle)({ handle, value });
    }

    persistMetaChange(handle, value) {
        this.debouncedPersistMetaFuncByHandle(handle)({ handle, value });
    }

    debouncedPersistValueFuncByHandle(handle) {
        const func = this.debouncedPersistValueFuncsByHandle[handle];
        if (func) return func;

        this.debouncedPersistValueFuncsByHandle[handle] = _.debounce(async (payload) => {
            await this.sendStateUpdate(payload.handle, payload.value, 'value');
        }, 1000);
        return this.debouncedPersistValueFuncsByHandle[handle];
    }

    debouncedPersistMetaFuncByHandle(handle) {
        const func = this.debouncedPersistMetaFuncsByHandle[handle];
        if (func) return func;

        this.debouncedPersistMetaFuncsByHandle[handle] = _.debounce(async (payload) => {
            await this.sendStateUpdate(payload.handle, payload.value, 'meta');
        }, 1000);
        return this.debouncedPersistMetaFuncsByHandle[handle];
    }

    async sendStateUpdate(handle, value, type) {
        try {
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
                || Statamic.$config.get('csrfToken');

            await fetch(this.stateApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': csrfToken,
                },
                credentials: 'same-origin',
                body: JSON.stringify({ handle, value, type }),
            });

            this.debug(`📦 Persisted ${type} change for "${handle}" to server`);
        } catch (error) {
            this.debug(`Failed to persist ${type} change`, { error });
        }
    }

    async clearCachedState() {
        try {
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
                || Statamic.$config.get('csrfToken');

            await fetch(this.stateApiUrl, {
                method: 'DELETE',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': csrfToken,
                },
                credentials: 'same-origin',
            });

            this.debug('🗑️ Cleared cached state from server');
        } catch (error) {
            this.debug('Failed to clear cached state', { error });
        }
    }

    resetActivityTimer() {
        // Clear existing timer
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }

        // Reset warning state
        this.inactivityWarningShown = false;

        // Start new timer
        this.inactivityTimer = setTimeout(() => {
            this.showInactivityWarning();
        }, this.inactivityTimeout);

        this.debug('Activity timer reset');
    }

    clearActivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    showInactivityWarning() {
        if (this.inactivityWarningShown) return;

        this.inactivityWarningShown = true;

        Statamic.$components.append('CollaborationBlockingNotification', {
            props: {
                title: 'Inactivity Warning',
                message: 'There has been no activity for 12 hours. Please close this content to avoid conflicts.',
                confirmText: 'Close'
            }
        }).on('confirm', () => {
            // Navigate away or close
            window.location.href = Statamic.$config.get('cpUrl') || '/cp';
        });

        this.debug('⚠️ Inactivity warning shown after 12 hours');
    }
}
