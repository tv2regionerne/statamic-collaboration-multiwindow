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

        // Toast notification flags (to avoid duplicate toasts)
        this.notSavedToastShown = false;
        this.unsavedToastShown = false;

        // Warm-up period: always broadcast for first few seconds after joining
        // This ensures sync works even before activeWindows is fully populated
        this.warmUpPeriod = true;
        this.warmUpDurationMs = 5000;

        // BroadcastChannel for reliable same-browser window detection
        this.localChannel = null;
        this.localWindows = new Set();

        // Sync interval: persist and fetch every 3 seconds while field is focused
        this.syncInterval = 3000;
        this.syncIntervalTimer = null;
        this.currentFocusedField = null;
        this.hasPendingChanges = false;

        // Field lock timing: 3 second delay before unlocking after blur
        this.fieldUnlockDelay = 3000;
        this.pendingFieldUnlocks = {}; // { handle: timeoutId }

        // Field inactivity: auto-unlock after 60 seconds of no activity
        this.fieldInactivityTimeout = 60000;
        this.fieldInactivityTimer = null;
    }

    generateWindowId() {
        const timestamp = Date.now().toString(36);
        const randomPart = crypto.getRandomValues(new Uint32Array(2))
            .reduce((acc, val) => acc + val.toString(36), '')
            .slice(0, 9);

        return `${timestamp}-${randomPart}`;
    }

    start() {
        if (this.started) return;

        this.initializeStateApi();
        this.initializeLocalChannel();
        this.initializeEcho();
        this.initializeStore();
        this.initializeFocus();
        this.initializeValuesAndMeta();
        this.initializeHooks();
        this.initializeStatusBar();
        this.initializeVisibilityHandler();
        this.started = true;
    }

    /**
     * Initialize BroadcastChannel for reliable same-browser window detection.
     * This works instantly between tabs without relying on WebSocket.
     */
    initializeLocalChannel() {
        const channelName = `collaboration-${this.container.reference}-${this.container.site}`;
        this.localChannel = new BroadcastChannel(channelName);

        this.localChannel.onmessage = (event) => {
            const { type, windowId } = event.data;

            if (windowId === this.windowId) return;

            switch (type) {
                case 'window-joined':
                    this.debug(`🖥️ Local window joined: ${windowId}`);
                    this.localWindows.add(windowId);
                    // Respond so the new window knows about us
                    this.localChannel.postMessage({ type: 'window-present', windowId: this.windowId });
                    break;

                case 'window-present':
                    this.debug(`🖥️ Local window present: ${windowId}`);
                    this.localWindows.add(windowId);
                    break;

                case 'window-left':
                    this.debug(`🖥️ Local window left: ${windowId}`);
                    this.localWindows.delete(windowId);
                    break;
            }
        };

        // Announce ourselves to other local windows
        this.localChannel.postMessage({ type: 'window-joined', windowId: this.windowId });
        this.debug('🖥️ Local channel initialized');
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

                // Skip sync if we have recent local changes (user is actively editing)
                const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
                if (timeSinceLastChange < this.localChangeProtectionMs) {
                    this.debug(`👁️ Window became visible but skipping sync - local change was ${timeSinceLastChange}ms ago`);
                    return;
                }

                this.debug('👁️ Window became visible after being hidden, syncing state...');

                // Wait for WebSocket connection to be ready before syncing
                const { wasDisconnected, reconnected } = await this.waitForConnection();

                // Fetch latest state from server
                await this.loadCachedState('visibilityHandler');

                // Re-announce ourselves to get fresh state from other windows
                this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });

                // Show toast if we had to reconnect
                if (wasDisconnected && reconnected) {
                    Statamic.$toast.success('Connection restored. Syncing latest changes...', { duration: 2000 });
                } else if (wasDisconnected && !reconnected) {
                    Statamic.$toast.error('Connection could not be restored. Please refresh the page.', { duration: false });
                }
            } else if (isNowVisible) {
                this.debug('👁️ Visibility event fired but window was not hidden, skipping sync');
            }
        };

        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    async waitForConnection(maxWaitMs = 5000) {
        const pusher = this.echo?.connector?.pusher;
        if (!pusher) return { wasDisconnected: false };

        if (pusher.connection?.state === 'connected') return { wasDisconnected: false };

        this.debug(`🔄 Waiting for reconnection...`);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.debug(`⚠️ Connection timeout`);
                resolve({ wasDisconnected: true, reconnected: false });
            }, maxWaitMs);

            const checkInterval = setInterval(() => {
                if (pusher.connection?.state === 'connected') {
                    clearTimeout(timeout);
                    clearInterval(checkInterval);
                    this.debug('✅ Connection restored');
                    resolve({ wasDisconnected: true, reconnected: true });
                }
            }, 100);
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

        // Stop sync interval and field inactivity timer
        this.stopSyncInterval();
        this.clearFieldInactivityTimer();

        // Clear pending field unlocks
        Object.keys(this.pendingFieldUnlocks).forEach(handle => {
            this.cancelPendingUnlock(handle);
        });

        // Remove keypress handler
        if (this.keypressHandler) {
            document.removeEventListener('keydown', this.keypressHandler);
        }

        // Remove visibility handler
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
        }

        // Announce that this window is leaving (via WebSocket)
        this.channel.whisper('window-left', { windowId: this.windowId });

        // Announce that this window is leaving (via BroadcastChannel)
        if (this.localChannel) {
            this.localChannel.postMessage({ type: 'window-left', windowId: this.windowId });
            this.localChannel.close();
        }

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

        this.channel.here(async users => {
            this.subscribeToVuexMutations();
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);

            // Register our own window
            this.activeWindows.add(this.windowId);

            // Start inactivity timer
            this.resetActivityTimer();

            // Start warm-up period (always broadcast during this time)
            this.warmUpPeriod = true;
            setTimeout(() => {
                this.warmUpPeriod = false;
                this.debug('🔥 Warm-up period ended');
            }, this.warmUpDurationMs);

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

            // Send current state to the new window (cleaned meta to avoid component errors)
            // The new window will get full data from server via loadCachedState
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
            if (windowId === this.windowId) return;

            this.debug(`Window left: ${windowId}`);
            this.activeWindows.delete(windowId);
        });

        // Listen for initial state from other windows (targeted to our windowId)
        // This always merges state since other windows may have fresher data than cached state
        this.channel.listenForWhisper(`initialize-state-for-window-${this.windowId}`, payload => {
            // Ignore if from our own window
            if (payload.fromWindowId === this.windowId) return;

            // Don't apply if we have recent local changes (prevents overwriting our own edits)
            const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
            if (timeSinceLastChange < this.localChangeProtectionMs) {
                this.debug(`🛡️ Skipping initialize-state - local change was ${timeSinceLastChange}ms ago`);
                return;
            }

            this.debug('✅ Applying/merging state from another window', payload);

            // Mark that we're applying external data to prevent re-broadcasting
            this.applyingBroadcast = true;
            try {
                // Merge values with current state
                // Use commit instead of dispatch to avoid triggering autosave
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...payload.values };
                Statamic.$store.commit(`publish/${this.container.name}/setValues`, mergedValues);

                // Merge meta with current state
                // Use commit instead of dispatch to avoid triggering autosave
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const restoredMeta = this.restoreEntireMetaPayload(payload.meta);
                const mergedMeta = { ...currentMeta };
                Object.keys(restoredMeta).forEach(handle => {
                    mergedMeta[handle] = { ...currentMeta[handle], ...restoredMeta[handle] };
                });
                Statamic.$store.commit(`publish/${this.container.name}/setMeta`, mergedMeta);
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

        // Listen for sync-now notifications - fetch latest state from server
        this.channel.listenForWhisper('sync-now', ({ windowId }) => {
            if (windowId === this.windowId) return;

            this.debug(`📥 Received sync-now from ${windowId?.slice(-6)}, fetching from server`);
            this.loadCachedState('sync-now');
        });

        this.listenForWhisper('focus', ({ user, handle, windowId }) => {
            // Ignore focus events from our own other windows
            if (windowId === this.windowId) return;

            this.debug(`Heard that user has changed focus`, { user, handle, windowId });

            // Cancel any pending unlock for this field (user is back)
            this.cancelPendingUnlock(handle);

            // Don't lock fields for our own other windows - only for other users
            if (user.id === this.user.id) {
                this.focus(user, handle);
            } else {
                this.focusAndLock(user, handle);
                // Show toast that another user is editing this field
                const fieldName = this.formatFieldName(handle);
                // Statamic.$toast.info(`${fieldName} is being edited by ${user.name}.`, { duration: 2000 });
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
                // Delay unlock by 3 seconds for other users
                this.blur(user);
                if (handle) {
                    this.scheduleDelayedUnlock(handle);
                }
            }
        });

        this.listenForWhisper('force-unlock', ({ targetUser, originUser, windowId }) => {
            // Ignore if from our own window
            if (windowId === this.windowId) return;

            this.debug(`Heard that user has requested another be unlocked`, { targetUser, originUser });

            if (targetUser.id !== this.user.id) return;

            document.activeElement.blur();
            this.blurAndUnlock(this.user);
            this.whisper('blur', { user: this.user, windowId: this.windowId });
            Statamic.$toast.info(`${originUser.name} has unlocked your editor.`, { duration: false });
        });

        this.listenForWhisper('saved', ({ user, windowId }) => {
            // Ignore if this is our own save action
            if (windowId === this.windowId) return;

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
                }
            }
        });
    }

    initializeStatusBar() {
        const component = this.container.pushComponent('CollaborationStatusBar', {
            props: {
                channelName: this.channelName,
            }
        });

        component.on('unlock', (targetUser) => {
            this.whisper('force-unlock', { targetUser, originUser: this.user, windowId: this.windowId });
        });
    }

    initializeHooks() {
        Statamic.$hooks.on('entry.saved', (resolve, reject, { reference }) => {
            if (reference === this.container.reference) {
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

            // Cancel any pending unlock for this field
            this.cancelPendingUnlock(handle);

            // Track currently focused field and start sync interval
            this.currentFocusedField = handle;
            this.startSyncInterval();
            this.resetFieldInactivityTimer();

            this.focus(user, handle);
            this.whisper('focus', { user, handle, windowId: this.windowId });
        });

        this.container.$on('blur', handle => {
            const user = this.user;

            // Stop sync interval and inactivity timer
            this.stopSyncInterval();
            this.clearFieldInactivityTimer();
            this.currentFocusedField = null;

            // Persist any pending changes immediately
            if (this.hasPendingChanges) {
                this.persistAllChanges();
            }

            // Tell other clients to sync now (fetch latest from server)
            this.channel.whisper('sync-now', { windowId: this.windowId });

            // Inform about blur but schedule delayed unlock
            this.blur(user);
            this.whisper('blur', { user, handle, windowId: this.windowId });

            // Field stays locked for 3 more seconds after blur
            this.scheduleDelayedUnlock(handle);
        });

        // Listen for keypress to reset field inactivity timer
        this.keypressHandler = () => {
            if (this.currentFocusedField) {
                this.resetFieldInactivityTimer();
            }
        };
        document.addEventListener('keydown', this.keypressHandler);
    }

    startSyncInterval() {
        this.stopSyncInterval();

        this.debug(`🔄 Starting sync interval (every ${this.syncInterval}ms)`);

        this.syncIntervalTimer = setInterval(() => {
            // Persist changes if we have any
            if (this.hasPendingChanges) {
                this.debug(`🔄 Sync interval: persisting changes`);
                this.persistAllChanges();
            }
        }, this.syncInterval);
    }

    stopSyncInterval() {
        if (this.syncIntervalTimer) {
            clearInterval(this.syncIntervalTimer);
            this.syncIntervalTimer = null;
            this.debug(`🔄 Stopped sync interval`);
        }
    }

    resetFieldInactivityTimer() {
        this.clearFieldInactivityTimer();

        this.fieldInactivityTimer = setTimeout(() => {
            if (this.currentFocusedField) {
                this.debug(`⏰ Field "${this.currentFocusedField}" inactive for 60 seconds, auto-unlocking`);
                this.autoUnlockField(this.currentFocusedField);
            }
        }, this.fieldInactivityTimeout);
    }

    clearFieldInactivityTimer() {
        if (this.fieldInactivityTimer) {
            clearTimeout(this.fieldInactivityTimer);
            this.fieldInactivityTimer = null;
        }
    }

    autoUnlockField(handle) {
        // Force blur the active element
        if (document.activeElement) {
            document.activeElement.blur();
        }

        // Stop sync interval and inactivity timer
        this.stopSyncInterval();
        this.clearFieldInactivityTimer();
        this.currentFocusedField = null;

        // Persist any pending changes
        if (this.hasPendingChanges) {
            this.persistAllChanges();
        }

        // Tell other clients to sync now
        this.channel.whisper('sync-now', { windowId: this.windowId });

        // Inform about blur and schedule delayed unlock
        this.blur(this.user);
        this.whisper('blur', { user: this.user, handle, windowId: this.windowId });
        this.scheduleDelayedUnlock(handle);

        Statamic.$toast.info(`Field auto-unlocked due to inactivity.`, { duration: 2000 });
    }

    async persistAllChanges() {
        if (!this.hasPendingChanges) return;

        this.hasPendingChanges = false;

        // Persist current values and meta to server
        const values = Statamic.$store.state.publish[this.container.name].values;
        const meta = Statamic.$store.state.publish[this.container.name].meta;

        try {
            await this.sendFullStateUpdate(values, meta);
            // Notify others to fetch
            this.channel.whisper('sync-now', { windowId: this.windowId });
            this.debug(`📦 Persisted all changes to server`);
        } catch (error) {
            this.debug(`Failed to persist changes`, { error });
            this.hasPendingChanges = true; // Retry on next interval
        }
    }

    scheduleDelayedUnlock(handle) {
        // Cancel any existing pending unlock for this field
        this.cancelPendingUnlock(handle);

        this.debug(`🔒 Scheduling unlock for "${handle}" in ${this.fieldUnlockDelay}ms`);

        this.pendingFieldUnlocks[handle] = setTimeout(async () => {
            this.debug(`🔓 Fetching data before unlocking "${handle}"`);

            // Fetch latest data from server BEFORE unlocking
            await this.loadCachedState('before-unlock');

            this.debug(`🔓 Executing delayed unlock for "${handle}"`);
            Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
            delete this.pendingFieldUnlocks[handle];
        }, this.fieldUnlockDelay);
    }

    cancelPendingUnlock(handle) {
        if (this.pendingFieldUnlocks[handle]) {
            clearTimeout(this.pendingFieldUnlocks[handle]);
            delete this.pendingFieldUnlocks[handle];
            this.debug(`🔓 Cancelled pending unlock for "${handle}"`);
        }
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
        if (!this.hasChanged('value', payload.handle, payload.value)) {
            return;
        }

        this.rememberChange('value', payload.handle, payload.value);

        // Update save status based on whether values differ from original
        this.updateSaveStatus();

        // Reset inactivity timer on any change
        this.resetActivityTimer();

        // Mark that we have pending changes (will be persisted by sync interval)
        if (!this.applyingBroadcast) {
            this.lastLocalChangeTime = Date.now();
            this.hasPendingChanges = true;
            this.debug(`📝 Value changed for ${payload.handle}, marked as pending`);
        }
    }

    // A field's meta value has been set in the vuex store.
    // It could have been triggered by the current user editing something,
    // or by the workspace applying a change dispatched by another user editing something.
    vuexFieldMetaHasBeenSet(payload) {
        if (!this.hasChanged('meta', payload.handle, payload.value)) {
            return;
        }

        this.rememberChange('meta', payload.handle, payload.value);

        // Reset inactivity timer on any change
        this.resetActivityTimer();

        // Mark that we have pending changes (will be persisted by sync interval)
        if (!this.applyingBroadcast) {
            this.hasPendingChanges = true;
            this.debug(`📝 Meta changed for ${payload.handle}, marked as pending`);
        }
    }

    rememberChange(type, handle, value) {
        const cache = type === 'value' ? this.lastValues : this.lastMetaValues;
        cache[handle] = clone(value);
    }

    hasChanged(type, handle, newValue) {
        const cache = type === 'value' ? this.lastValues : this.lastMetaValues;
        const lastValue = cache[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    updateSaveStatus() {
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

    // Allow fieldtypes to provide an array of keys that will be broadcasted.
    // For example, in Bard, only the "existing" value in its meta object
    // ever gets updated. We'll just broadcast that, rather than the
    // whole thing, which would be wasted bytes in the message.
    cleanMetaPayload(payload) {
        const allowed = data_get(payload, 'value.__collaboration');
        if (!allowed) return payload;
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
            return { ...this.lastMetaValues[key], ...value };
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

    debug(message, args) {
        if (!Statamic.$config.get('collaboration.debug')) return;
        console.log(`[Collaboration ${this.windowId?.slice(-6) || 'init'}]`, message, { ...args });
    }

    isAlone() {
        // During warm-up period, assume we're not alone (ensures sync works while windows are joining)
        if (this.warmUpPeriod) {
            this.debug('isAlone check: in warm-up period, returning false');
            return false;
        }

        // Check multiple sources for other windows/users
        const users = Statamic.$store.state.collaboration[this.channelName]?.users || [];
        const multipleUsers = users.length > 1;
        const multipleRemoteWindows = this.activeWindows.size > 1;
        const multipleLocalWindows = this.localWindows.size > 0; // Other local windows in same browser

        // Not alone if multiple users OR multiple remote windows OR other local windows
        const alone = !multipleUsers && !multipleRemoteWindows && !multipleLocalWindows;

        this.debug(`isAlone check: users=${users.length}, remoteWindows=${this.activeWindows.size}, localWindows=${this.localWindows.size}, alone=${alone}`);
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
                chunk: str.slice(i * chunkSize, (i + 1) * chunkSize),
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
            if (!events.hasOwnProperty(data.id)) {
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
        const audioFiles = { 'buddy-in': buddyIn, 'buddy-out': buddyOut };
        const el = document.createElement('audio');
        el.src = audioFiles[file];
        el.volume = 0.25;
        el.addEventListener('ended', () => el.remove());
        document.body.appendChild(el);
        el.play();
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

    async loadCachedState(source = 'unknown') {
        // Prevent concurrent loadCachedState calls
        if (this.loadingCachedState) {
            this.debug(`🔄 loadCachedState already in progress, skipping call from: ${source}`);
            return;
        }

        // Don't overwrite if user has made recent local changes (protects against losing typing)
        // Exception: before-unlock always fetches to ensure we have latest data
        if (source !== 'before-unlock') {
            const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
            if (timeSinceLastChange < this.localChangeProtectionMs) {
                this.debug(`🛡️ Skipping loadCachedState (${source}) - local change was ${timeSinceLastChange}ms ago`);
                return;
            }
        }

        this.loadingCachedState = true;
        this.debug(`🔄 loadCachedState called from: ${source}`);

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

            this.debug('✅ Applying cached state from server', {
                valuesKeys: data.values ? Object.keys(data.values) : [],
                metaKeys: data.meta ? Object.keys(data.meta) : []
            });

            // Apply cached values - merge with current values
            if (data.values && Object.keys(data.values).length > 0) {
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...data.values };

                this.debug('📝 Committing setValues...', {
                    changedKeys: Object.keys(data.values)
                });
                Statamic.$store.commit(`publish/${this.container.name}/setValues`, mergedValues);

                // Update lastValues so we don't re-send these as changes
                Object.keys(data.values).forEach(handle => {
                    this.lastValues[handle] = clone(data.values[handle]);
                });
                this.debug('📝 setValues commit completed');
            }

            // Apply cached meta - merge with current meta
            if (data.meta && Object.keys(data.meta).length > 0) {
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const mergedMeta = { ...currentMeta };
                Object.keys(data.meta).forEach(handle => {
                    mergedMeta[handle] = { ...currentMeta[handle], ...data.meta[handle] };
                });

                this.debug('📝 Committing setMeta...', {
                    changedKeys: Object.keys(data.meta)
                });
                Statamic.$store.commit(`publish/${this.container.name}/setMeta`, mergedMeta);

                // Update lastMetaValues so we don't re-send these as changes
                Object.keys(data.meta).forEach(handle => {
                    this.lastMetaValues[handle] = clone(mergedMeta[handle]);
                });
                this.debug('📝 setMeta commit completed');
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

    async sendFullStateUpdate(values, meta) {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
            || Statamic.$config.get('csrfToken');

        this.debug('📤 Sending full state update to server', {
            valuesKeys: Object.keys(values || {}),
            metaKeys: Object.keys(meta || {}),
            url: this.stateApiUrl
        });

        const response = await fetch(this.stateApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-TOKEN': csrfToken,
            },
            credentials: 'same-origin',
            body: JSON.stringify({ values, meta, full: true }),
        });

        if (!response.ok) {
            this.debug('❌ Failed to send state update', { status: response.status });
            throw new Error(`HTTP ${response.status}`);
        }

        this.debug('✅ State update sent successfully');
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
