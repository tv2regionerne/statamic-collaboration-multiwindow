import buddyIn from '../audio/buddy-in.mp3'
import buddyOut from '../audio/buddy-out.mp3'

/**
 * Workspace Class
 *
 * Manages real-time collaboration for a single Statamic entry. Each browser tab/window
 * that opens an entry creates its own Workspace instance. The class handles:
 *
 * - WebSocket communication via Laravel Echo for real-time sync
 * - Field locking to prevent concurrent edits on the same field
 * - State persistence to server cache for recovery and new window sync
 * - Multi-window support (same user can have multiple tabs open)
 * - Inactivity detection and auto-unlock
 *
 * Architecture:
 * - Changes are persisted to server every 3 seconds while a field is focused
 * - Other clients are notified via WebSocket to fetch the latest state
 * - Fields remain locked for 3 seconds after blur to prevent race conditions
 * - Auto-unlock triggers after 30 seconds of inactivity in a field
 */
export default class Workspace {

    /**
     * Initialize the workspace with configuration and state tracking variables.
     * @param {Object} container - The Statamic publish container instance
     */
    constructor(container) {
        this.container = container;
        this.echo = null;
        this.started = false;
        this.storeSubscriber = null;

        // Cache for detecting changes (prevents unnecessary broadcasts)
        this.lastValues = {};
        this.lastMetaValues = {};

        // Current user reference
        this.user = Statamic.user;

        // API endpoint for state persistence (set in initializeStateApi)
        this.stateApiUrl = null;

        // Unique ID for this window/tab to distinguish from same user in other windows
        this.windowId = this.generateWindowId();

        // Track all active windows (not just users) for proper broadcast logic
        this.activeWindows = new Set();

        // Flag to prevent re-broadcasting changes that came from other windows
        this.applyingBroadcast = false;

        // Session inactivity tracking (12 hours before warning)
        this.inactivityTimeout = 12 * 60 * 60 * 1000;
        this.inactivityTimer = null;
        this.inactivityWarningShown = false;

        // Mutex to prevent concurrent loadCachedState calls
        this.loadingCachedState = false;

        // Protection window for local changes (prevents overwriting recent typing)
        this.lastLocalChangeTime = 0;
        this.localChangeProtectionMs = 3000;

        // Toast notification flags (prevents duplicate toasts)
        this.notSavedToastShown = false;
        this.unsavedToastShown = false;

        // Warm-up period: always broadcast for first few seconds after joining
        // This ensures sync works even before activeWindows is fully populated
        this.warmUpPeriod = true;
        this.warmUpDurationMs = 5000;

        // BroadcastChannel for instant same-browser window detection (faster than WebSocket)
        this.localChannel = null;
        this.localWindows = new Set();

        // Sync interval: persist changes every 3 seconds while a field is focused
        this.syncInterval = 3000;
        this.syncIntervalTimer = null;
        this.currentFocusedField = null;
        this.hasPendingChanges = false;

        // Field lock timing: keep field locked for 3 seconds after user leaves
        this.fieldUnlockDelay = 3000;
        this.pendingFieldUnlocks = {};

        // Field inactivity: auto-unlock after 30 seconds of no keyboard activity
        this.fieldInactivityTimeout = 30000;
        this.fieldInactivityTimer = null;

        // API timeout for all fetch requests (4 seconds)
        this.apiTimeout = 4000;

        // Cached CSRF token (looked up once, reused for all requests)
        this._csrfToken = null;
    }

    /**
     * Get cached CSRF token for API requests.
     * @returns {string} The CSRF token
     */
    get csrfToken() {
        if (!this._csrfToken) {
            this._csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
                || Statamic.$config.get('csrfToken');
        }
        return this._csrfToken;
    }

    /**
     * Generate a unique window ID using timestamp and cryptographic random values.
     * Format: "base36timestamp-randomstring" (e.g., "lz1abc-xyz123456")
     * @returns {string} Unique window identifier
     */
    generateWindowId() {
        const timestamp = Date.now().toString(36);
        const randomPart = crypto.getRandomValues(new Uint32Array(2))
            .reduce((acc, val) => acc + val.toString(36), '')
            .slice(0, 9);

        return `${timestamp}-${randomPart}`;
    }

    /**
     * Start the workspace and initialize all subsystems.
     * Called when the publish container is ready.
     */
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
     * Initialize BroadcastChannel for instant same-browser window detection.
     * This is faster than WebSocket for detecting other tabs in the same browser.
     * Uses a channel name specific to this entry and site.
     */
    initializeLocalChannel() {
        const channelName = `collaboration-${this.container.reference}-${this.container.site}`;
        this.localChannel = new BroadcastChannel(channelName);

        this.localChannel.onmessage = (event) => {
            const { type, windowId } = event.data;

            // Ignore our own messages
            if (windowId === this.windowId) return;

            switch (type) {
                case 'window-joined':
                    this.debug(`Local window joined: ${windowId}`);
                    this.localWindows.add(windowId);
                    // Respond so the new window knows about us
                    this.localChannel.postMessage({ type: 'window-present', windowId: this.windowId });
                    break;

                case 'window-present':
                    this.debug(`Local window present: ${windowId}`);
                    this.localWindows.add(windowId);
                    break;

                case 'window-left':
                    this.debug(`Local window left: ${windowId}`);
                    this.localWindows.delete(windowId);
                    break;
            }
        };

        // Announce ourselves to other local windows
        this.localChannel.postMessage({ type: 'window-joined', windowId: this.windowId });
        this.debug('Local channel initialized');
    }

    /**
     * Initialize visibility change handler for tab switching.
     * When a tab becomes visible after being hidden, sync state from server
     * to catch any changes made while the tab was in the background.
     */
    initializeVisibilityHandler() {
        this.wasHidden = document.visibilityState === 'hidden';

        this.visibilityHandler = async () => {
            const isNowVisible = document.visibilityState === 'visible';
            const isNowHidden = document.visibilityState === 'hidden';

            if (isNowHidden) {
                this.wasHidden = true;
                this.debug('Window became hidden');
                return;
            }

            if (isNowVisible && this.wasHidden) {
                this.wasHidden = false;

                // Skip sync if user is actively editing (protect recent changes)
                const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
                if (timeSinceLastChange < this.localChangeProtectionMs) {
                    this.debug(`Window visible but skipping sync - local change was ${timeSinceLastChange}ms ago`);
                    return;
                }

                this.debug('Window became visible, syncing state...');

                // Wait for WebSocket reconnection if needed
                const { wasDisconnected, reconnected } = await this.waitForConnection();

                // Fetch latest state from server
                await this.loadCachedState('visibilityHandler');

                // Re-announce ourselves to get fresh state from other windows
                this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });

                // Notify user about connection status
                if (wasDisconnected && reconnected) {
                    Statamic.$toast.success('Connection restored. Syncing latest changes...', { duration: 2000 });
                } else if (wasDisconnected && !reconnected) {
                    Statamic.$toast.error('Connection could not be restored. Please refresh the page.', { duration: false });
                }
            }
        };

        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    /**
     * Wait for WebSocket connection to be ready.
     * Used after tab becomes visible to ensure we can communicate.
     * @param {number} maxWaitMs - Maximum time to wait for connection (default: 5000ms)
     * @returns {Promise<{wasDisconnected: boolean, reconnected: boolean}>}
     */
    async waitForConnection(maxWaitMs = 5000) {
        const pusher = this.echo?.connector?.pusher;
        if (!pusher) return { wasDisconnected: false };

        // Already connected
        if (pusher.connection?.state === 'connected') return { wasDisconnected: false };

        this.debug('Waiting for reconnection...');

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.debug('Connection timeout');
                resolve({ wasDisconnected: true, reconnected: false });
            }, maxWaitMs);

            const checkInterval = setInterval(() => {
                if (pusher.connection?.state === 'connected') {
                    clearTimeout(timeout);
                    clearInterval(checkInterval);
                    this.debug('Connection restored');
                    resolve({ wasDisconnected: true, reconnected: true });
                }
            }, 100);
        });
    }

    /**
     * Initialize the API URL for state persistence.
     * Converts the entry reference to URL-safe format.
     */
    initializeStateApi() {
        const reference = this.container.reference.replaceAll('::', '.');
        const site = this.container.site.replaceAll('.', '_');
        const cpUrl = Statamic.$config.get('cpUrl') || '/cp';
        this.stateApiUrl = `${cpUrl}/collaboration/state/${reference}/${site}`;
    }

    /**
     * Clean up and destroy the workspace.
     * Called when navigating away or closing the entry.
     * Removes all event listeners and notifies other windows.
     */
    destroy() {
        // Clear all timers
        this.clearActivityTimer();
        this.stopSyncInterval();
        this.clearFieldInactivityTimer();

        // Clear pending field unlocks
        Object.keys(this.pendingFieldUnlocks).forEach(handle => {
            this.cancelPendingUnlock(handle);
        });

        // If we have a focused field, release it properly before leaving
        if (this.currentFocusedField) {
            const handle = this.currentFocusedField;
            this.currentFocusedField = null;

            // Notify others about blur so they can unlock the field
            this.blur(this.user);
            this.whisper('blur', { user: this.user, handle, windowId: this.windowId });
        }

        // Persist any pending changes before leaving (fire-and-forget, don't await)
        if (this.hasPendingChanges) {
            this.persistAllChanges();
        }

        // Remove event listeners
        if (this.keypressHandler) {
            document.removeEventListener('keydown', this.keypressHandler);
        }
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
        }

        // Announce departure via WebSocket
        this.channel.whisper('window-left', { windowId: this.windowId });

        // Announce departure via BroadcastChannel and close it
        if (this.localChannel) {
            this.localChannel.postMessage({ type: 'window-left', windowId: this.windowId });
            this.localChannel.close();
        }

        // Clean up tracking
        this.activeWindows.delete(this.windowId);

        // Unsubscribe from Vuex and leave WebSocket channel
        this.storeSubscriber.apply();
        this.echo.leave(this.channelName);
    }

    /**
     * Initialize Laravel Echo WebSocket channel and set up all listeners.
     * This is the core of the real-time collaboration system.
     */
    initializeEcho() {
        // Create channel name from entry reference and site
        const reference = this.container.reference.replaceAll('::', '.');
        this.channelName = `${reference}.${this.container.site.replaceAll('.', '_')}`;
        this.channel = this.echo.join(this.channelName);

        // Called when we successfully join the channel with list of current users
        this.channel.here(async users => {
            this.subscribeToVuexMutations();
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);

            // If others are already here, remove autofocus to prevent accidental field locking
            if (users.length > 1 && document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }

            // Register our window and start timers
            this.activeWindows.add(this.windowId);
            this.resetActivityTimer();

            // During warm-up, always broadcast (activeWindows may not be fully populated yet)
            this.warmUpPeriod = true;
            setTimeout(() => {
                this.warmUpPeriod = false;
                this.debug('Warm-up period ended');
            }, this.warmUpDurationMs);

            // Load any cached state from server (handles reconnects and stale data)
            await this.loadCachedState('channel.here');

            // Announce ourselves so other windows can send us their state
            this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });
        });

        // Handle new windows joining
        this.channel.listenForWhisper('window-joined', ({ windowId, user }) => {
            if (windowId === this.windowId) return;

            this.debug(`Window joined: ${windowId}`, { user });
            this.activeWindows.add(windowId);

            // Respond so the new window knows about us
            this.channel.whisper('window-present', { windowId: this.windowId, user: this.user });

            // Send our current state to help the new window sync
            this.channel.whisper(`initialize-state-for-window-${windowId}`, {
                values: Statamic.$store.state.publish[this.container.name].values,
                meta: this.cleanEntireMetaPayload(Statamic.$store.state.publish[this.container.name].meta),
                focus: Statamic.$store.state.collaboration[this.channelName].focus,
                fromWindowId: this.windowId,
            });
        });

        // Handle existing windows announcing themselves
        this.channel.listenForWhisper('window-present', ({ windowId }) => {
            if (windowId === this.windowId) return;

            this.debug(`Window present: ${windowId}`);
            this.activeWindows.add(windowId);
        });

        // Handle windows leaving
        this.channel.listenForWhisper('window-left', ({ windowId }) => {
            if (windowId === this.windowId) return;

            this.debug(`Window left: ${windowId}`);
            this.activeWindows.delete(windowId);
        });

        // Handle initial state from other windows (targeted specifically to us)
        this.channel.listenForWhisper(`initialize-state-for-window-${this.windowId}`, payload => {
            if (payload.fromWindowId === this.windowId) return;

            // Protect recent local changes from being overwritten
            const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
            if (timeSinceLastChange < this.localChangeProtectionMs) {
                this.debug(`Skipping initialize-state - local change was ${timeSinceLastChange}ms ago`);
                return;
            }

            this.debug('Applying state from another window', payload);

            // Prevent re-broadcasting while applying external changes
            this.applyingBroadcast = true;
            try {
                // Merge received values with current state
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...payload.values };
                Statamic.$store.commit(`publish/${this.container.name}/setValues`, mergedValues);

                // Merge received meta with current state
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

            // Apply focus locks from other users (not our own windows)
            _.each(payload.focus, ({ user, handle }) => {
                if (user.id !== this.user.id) {
                    this.focusAndLock(user, handle);
                }
            });
        });

        // Handle user joining (presence channel event)
        this.channel.joining(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/addUser`, user);

            // Only notify for other users (not our own other windows)
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has joined.`, { duration: 2000 });
                if (Statamic.$config.get('collaboration.sound_effects')) {
                    this.playAudio('buddy-in');
                }
            }
        });

        // Handle user leaving (presence channel event)
        this.channel.leaving(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/removeUser`, user);

            // Only notify for other users
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has left.`, { duration: 2000 });
                if (Statamic.$config.get('collaboration.sound_effects')) {
                    this.playAudio('buddy-out');
                }
            }

            // Release any locks held by the leaving user
            this.blurAndUnlock(user);
        });

        // Handle sync-now notifications (fetch latest state from server)
        this.channel.listenForWhisper('sync-now', ({ windowId }) => {
            if (windowId === this.windowId) return;

            this.debug(`Received sync-now from ${windowId?.slice(-6)}, fetching from server`);
            this.loadCachedState('sync-now');
        });

        // Handle focus events (field locking)
        this.listenForWhisper('focus', ({ user, handle, windowId }) => {
            if (windowId === this.windowId) return;

            this.debug('User focused field', { user, handle, windowId });

            // Cancel any pending unlock (user is back editing)
            this.cancelPendingUnlock(handle);

            // Lock field for other users, just track focus for our own other windows
            if (user.id === this.user.id) {
                this.focus(user, handle);
            } else {
                this.focusAndLock(user, handle);
            }
        });

        // Handle blur events (field releasing)
        this.listenForWhisper('blur', ({ user, handle, windowId }) => {
            if (windowId === this.windowId) return;

            this.debug('User blurred field', { user, handle, windowId });

            // For other users, schedule delayed unlock (field stays locked for 3 more seconds)
            if (user.id === this.user.id) {
                this.blur(user);
            } else {
                this.blur(user);
                if (handle) {
                    this.scheduleDelayedUnlock(handle);
                }
            }
        });

        // Handle force-unlock requests (admin can unlock another user's field)
        this.listenForWhisper('force-unlock', ({ targetUser, originUser, windowId }) => {
            if (windowId === this.windowId) return;

            this.debug('Force unlock requested', { targetUser, originUser });

            // Only respond if we are the target
            if (targetUser.id !== this.user.id) return;

            document.activeElement.blur();
            this.blurAndUnlock(this.user);
            this.whisper('blur', { user: this.user, windowId: this.windowId });
            Statamic.$toast.info(`${originUser.name} has unlocked your editor.`, { duration: false });
        });

        // Handle save notifications
        this.listenForWhisper('saved', ({ user, windowId }) => {
            if (windowId === this.windowId) return;

            // Update our state to reflect the save
            const currentValues = Statamic.$store.state.publish[this.container.name].values;
            Statamic.$store.commit(`collaboration/${this.channelName}/setOriginalValues`, clone(currentValues));
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');

            this.unsavedToastShown = false;
            this.notSavedToastShown = false;

            Statamic.$toast.success(`Saved by ${user.name}.`);
        });

        // Handle publish notifications (requires page reload)
        this.listenForWhisper('published', ({ user, message, windowId }) => {
            if (windowId === this.windowId) return;

            Statamic.$toast.success(`Published by ${user.name}.`);
            const messageProp = message
                ? `Entry has been published by ${user.name} with the message: ${message}`
                : `Entry has been published by ${user.name} with no message.`;
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: messageProp }
            }).on('confirm', () => window.location.reload());
            this.destroy();
        });

        // Handle revision restore notifications (requires page reload)
        this.listenForWhisper('revision-restored', ({ user, windowId }) => {
            if (windowId === this.windowId) return;

            Statamic.$toast.success(`Revision restored by ${user.name}.`);
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: `Entry has been restored to another revision by ${user.name}` }
            }).on('confirm', () => window.location.reload());
            this.destroy();
        });
    }

    /**
     * Initialize the Vuex store module for collaboration state.
     * Tracks users, focus state, and save status.
     */
    initializeStore() {
        // Detect new entries (not yet saved to database)
        const isNewEntry = this.container.reference.includes('create') ||
            !this.container.reference.match(/[a-f0-9-]{36}$/i);

        Statamic.$store.registerModule(['collaboration', this.channelName], {
            namespaced: true,
            state: {
                users: [],
                focus: {},
                saveStatus: isNewEntry ? 'notSaved' : 'saved',
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

    /**
     * Initialize the status bar component in the publish form sidebar.
     * Shows connected users and provides unlock controls.
     */
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

    /**
     * Initialize Statamic hooks for save/publish/restore events.
     * Notifies other windows when entry lifecycle events occur.
     */
    initializeHooks() {
        // Hook into entry save
        Statamic.$hooks.on('entry.saved', (resolve, _reject, { reference }) => {
            if (reference === this.container.reference) {
                // Update local state to reflect save
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                Statamic.$store.commit(`collaboration/${this.channelName}/setOriginalValues`, clone(currentValues));
                Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');

                this.unsavedToastShown = false;
                this.notSavedToastShown = false;

                // Clear cached state (no longer needed after save)
                this.clearCachedState();

                // Notify all windows (force=true includes our own other windows)
                this.whisper('saved', { user: this.user, windowId: this.windowId }, { force: true });
            }
            resolve();
        });

        // Hook into entry publish
        Statamic.$hooks.on('entry.published', (resolve, _reject, { reference, message }) => {
            if (reference === this.container.reference) {
                this.whisper('published', { user: this.user, message, windowId: this.windowId }, { force: true });
            }
            resolve();
        });

        // Hook into revision restore
        Statamic.$hooks.on('revision.restored', (resolve, _reject, { reference }) => {
            if (reference !== this.container.reference) return resolve();

            this.whisper('revision-restored', { user: this.user, windowId: this.windowId }, { force: true });

            // Wait for whisper to be sent before page refreshes
            setTimeout(resolve, 500);
        });
    }

    /**
     * Initialize focus/blur event handlers for field locking.
     * Also sets up keyboard listener for inactivity detection.
     */
    initializeFocus() {
        // Handle field focus
        this.container.$on('focus', handle => {
            const user = this.user;

            // Cancel any pending unlock for this field
            this.cancelPendingUnlock(handle);

            // Start tracking this field and begin sync interval
            this.currentFocusedField = handle;
            this.startSyncInterval();
            this.resetFieldInactivityTimer();

            this.focus(user, handle);
            this.whisper('focus', { user, handle, windowId: this.windowId });
        });

        // Handle field blur
        this.container.$on('blur', async handle => {
            const user = this.user;

            // Stop sync and inactivity tracking
            this.stopSyncInterval();
            this.clearFieldInactivityTimer();
            this.currentFocusedField = null;

            // Persist any pending changes before notifying others
            if (this.hasPendingChanges) {
                await this.persistAllChanges();
            }

            // Tell other clients to fetch latest state (data is now on server)
            this.channel.whisper('sync-now', { windowId: this.windowId });

            // Update local state and notify others
            this.blur(user);
            this.whisper('blur', { user, handle, windowId: this.windowId });

            // Field stays locked for 3 more seconds (prevents race conditions)
            this.scheduleDelayedUnlock(handle);
        });

        // Track keyboard activity to reset inactivity timer
        this.keypressHandler = () => {
            if (this.currentFocusedField) {
                this.resetFieldInactivityTimer();
            }
        };
        document.addEventListener('keydown', this.keypressHandler);
    }

    /**
     * Start the sync interval timer.
     * Persists changes to server every 3 seconds while a field is focused.
     */
    startSyncInterval() {
        this.stopSyncInterval();

        this.debug(`Starting sync interval (every ${this.syncInterval}ms)`);

        this.syncIntervalTimer = setInterval(() => {
            if (this.hasPendingChanges) {
                this.debug('Sync interval: persisting changes');
                this.persistAllChanges();
            }
        }, this.syncInterval);
    }

    /**
     * Stop the sync interval timer.
     */
    stopSyncInterval() {
        if (this.syncIntervalTimer) {
            clearInterval(this.syncIntervalTimer);
            this.syncIntervalTimer = null;
            this.debug('Stopped sync interval');
        }
    }

    /**
     * Reset the field inactivity timer.
     * Called on every keypress while a field is focused.
     */
    resetFieldInactivityTimer() {
        this.clearFieldInactivityTimer();

        this.fieldInactivityTimer = setTimeout(() => {
            if (this.currentFocusedField) {
                this.debug(`Field "${this.currentFocusedField}" inactive for 30 seconds, auto-unlocking`);
                this.autoUnlockField(this.currentFocusedField);
            }
        }, this.fieldInactivityTimeout);
    }

    /**
     * Clear the field inactivity timer.
     */
    clearFieldInactivityTimer() {
        if (this.fieldInactivityTimer) {
            clearTimeout(this.fieldInactivityTimer);
            this.fieldInactivityTimer = null;
        }
    }

    /**
     * Auto-unlock a field due to inactivity.
     * Forces blur, persists changes, and notifies other windows.
     * @param {string} handle - The field handle to unlock
     */
    async autoUnlockField(handle) {
        // Force blur the active element
        if (document.activeElement) {
            document.activeElement.blur();
        }

        // Clean up tracking
        this.stopSyncInterval();
        this.clearFieldInactivityTimer();
        this.currentFocusedField = null;

        // Persist any pending changes before notifying
        if (this.hasPendingChanges) {
            await this.persistAllChanges();
        }

        // Notify other clients to sync
        this.channel.whisper('sync-now', { windowId: this.windowId });

        // Update state and notify
        this.blur(this.user);
        this.whisper('blur', { user: this.user, handle, windowId: this.windowId });
        this.scheduleDelayedUnlock(handle);

        Statamic.$toast.info('Field auto-unlocked due to inactivity.', { duration: 2000 });
    }

    /**
     * Persist all pending changes to the server.
     * Called by sync interval and on blur.
     */
    async persistAllChanges() {
        if (!this.hasPendingChanges) return;

        this.hasPendingChanges = false;

        const values = Statamic.$store.state.publish[this.container.name].values;
        const meta = Statamic.$store.state.publish[this.container.name].meta;

        try {
            await this.sendFullStateUpdate(values, meta);
            this.debug('Persisted all changes to server');
        } catch (error) {
            this.debug('Failed to persist changes', { error });
            this.hasPendingChanges = true; // Retry on next interval
        }
    }

    /**
     * Schedule a delayed unlock for a field.
     * Field remains locked for 3 seconds after blur, then fetches latest data before unlocking.
     * @param {string} handle - The field handle to unlock
     */
    scheduleDelayedUnlock(handle) {
        this.cancelPendingUnlock(handle);

        this.debug(`Scheduling unlock for "${handle}" in ${this.fieldUnlockDelay}ms`);

        this.pendingFieldUnlocks[handle] = setTimeout(async () => {
            this.debug(`Fetching data before unlocking "${handle}"`);

            // Fetch latest data BEFORE unlocking to ensure UI shows current state
            await this.loadCachedState('before-unlock');

            this.debug(`Executing delayed unlock for "${handle}"`);
            Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
            delete this.pendingFieldUnlocks[handle];
        }, this.fieldUnlockDelay);
    }

    /**
     * Cancel a pending field unlock.
     * Called when user re-focuses a field before unlock timeout.
     * @param {string} handle - The field handle
     */
    cancelPendingUnlock(handle) {
        if (this.pendingFieldUnlocks[handle]) {
            clearTimeout(this.pendingFieldUnlocks[handle]);
            delete this.pendingFieldUnlocks[handle];
            this.debug(`Cancelled pending unlock for "${handle}"`);
        }
    }

    /**
     * Track focus state for a user in the Vuex store.
     * @param {Object} user - The user object
     * @param {string} handle - The field handle
     */
    focus(user, handle) {
        Statamic.$store.commit(`collaboration/${this.channelName}/focus`, { user, handle });
    }

    /**
     * Track focus and lock the field (prevents other users from editing).
     * @param {Object} user - The user object
     * @param {string} handle - The field handle
     */
    focusAndLock(user, handle) {
        this.focus(user, handle);
        Statamic.$store.commit(`publish/${this.container.name}/lockField`, { user, handle });
    }

    /**
     * Clear focus state for a user.
     * @param {Object} user - The user object
     */
    blur(user) {
        Statamic.$store.commit(`collaboration/${this.channelName}/blur`, user);
    }

    /**
     * Clear focus and unlock the field.
     * @param {Object} user - The user object
     * @param {string|null} handle - The field handle (auto-detected if not provided)
     */
    blurAndUnlock(user, handle = null) {
        handle = handle || data_get(Statamic.$store.state.collaboration[this.channelName], `focus.${user.id}.handle`);
        if (!handle) return;
        this.blur(user);
        Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
    }

    /**
     * Subscribe to Vuex mutations to detect local value changes.
     * This is how we know when to persist and broadcast changes.
     */
    subscribeToVuexMutations() {
        this.storeSubscriber = Statamic.$store.subscribe((mutation) => {
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

    /**
     * Handle field value changes in Vuex store.
     * Marks changes as pending for the next sync interval.
     * @param {Object} payload - The mutation payload with handle and value
     */
    vuexFieldValueHasBeenSet(payload) {
        if (!this.hasChanged('value', payload.handle, payload.value)) {
            return;
        }

        this.rememberChange('value', payload.handle, payload.value);
        this.updateSaveStatus();
        this.resetActivityTimer();

        // Only mark as pending if this is a local change (not from broadcast)
        if (!this.applyingBroadcast) {
            this.lastLocalChangeTime = Date.now();
            this.hasPendingChanges = true;
            this.debug(`Value changed for ${payload.handle}, marked as pending`);
        }
    }

    /**
     * Handle field meta changes in Vuex store.
     * @param {Object} payload - The mutation payload with handle and value
     */
    vuexFieldMetaHasBeenSet(payload) {
        if (!this.hasChanged('meta', payload.handle, payload.value)) {
            return;
        }

        this.rememberChange('meta', payload.handle, payload.value);
        this.resetActivityTimer();

        if (!this.applyingBroadcast) {
            this.hasPendingChanges = true;
            this.debug(`Meta changed for ${payload.handle}, marked as pending`);
        }
    }

    /**
     * Remember a change for later comparison.
     * @param {string} type - 'value' or 'meta'
     * @param {string} handle - The field handle
     * @param {*} value - The new value
     */
    rememberChange(type, handle, value) {
        const cache = type === 'value' ? this.lastValues : this.lastMetaValues;
        cache[handle] = clone(value);
    }

    /**
     * Check if a value has changed from the last remembered value.
     * @param {string} type - 'value' or 'meta'
     * @param {string} handle - The field handle
     * @param {*} newValue - The new value to compare
     * @returns {boolean} True if the value has changed
     */
    hasChanged(type, handle, newValue) {
        const cache = type === 'value' ? this.lastValues : this.lastMetaValues;
        const lastValue = cache[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    /**
     * Update the save status based on whether current values differ from original.
     * Shows appropriate toast notifications.
     */
    updateSaveStatus() {
        const state = Statamic.$store.state.collaboration[this.channelName];
        const currentStatus = state.saveStatus;

        // Show one-time toast for new entries
        if (currentStatus === 'notSaved' && !this.notSavedToastShown) {
            this.notSavedToastShown = true;
            Statamic.$toast.info('New entry — changes stored temporarily for 12 hours.');
            return;
        }

        const currentValues = Statamic.$store.state.publish[this.container.name].values;
        const originalValues = state.originalValues;

        if (!originalValues) return;

        const hasChanges = JSON.stringify(currentValues) !== JSON.stringify(originalValues);

        if (hasChanges && currentStatus !== 'changesNotSaved') {
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'changesNotSaved');
            this.debug('Save status changed to: changesNotSaved');
            if (!this.unsavedToastShown) {
                this.unsavedToastShown = true;
                Statamic.$toast.info('Unsaved changes — stored temporarily for 12 hours.');
            }
        } else if (!hasChanges && currentStatus !== 'saved') {
            Statamic.$store.commit(`collaboration/${this.channelName}/setSaveStatus`, 'saved');
            this.debug('Save status changed to: saved');
            this.unsavedToastShown = false;
        }
    }

    /**
     * Clean meta payload by extracting only collaboration-relevant keys.
     * Used when broadcasting to reduce message size.
     * @param {Object} values - The full meta values object
     * @returns {Object} Cleaned meta with only relevant keys
     */
    cleanEntireMetaPayload(values) {
        return _.mapObject(values, meta => {
            const allowed = data_get(meta, '__collaboration');
            if (!allowed) return meta;
            let allowedValues = {};
            allowed.forEach(key => allowedValues[key] = meta[key]);
            return allowedValues;
        });
    }

    /**
     * Restore meta payload by merging with last known values.
     * @param {Object} payload - The received meta payload
     * @returns {Object} Restored meta with full values
     */
    restoreEntireMetaPayload(payload) {
        return _.mapObject(payload, (value, key) => {
            return { ...this.lastMetaValues[key], ...value };
        });
    }

    /**
     * Format a field handle for display in toasts.
     * Converts "my_field_name" or "myFieldName" to "My field name".
     * @param {string} handle - The field handle
     * @returns {string} Human-readable field name
     */
    formatFieldName(handle) {
        if (!handle) return 'Field';
        return handle
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, str => str.toUpperCase());
    }

    /**
     * Log debug messages when collaboration.debug is enabled.
     * @param {string} message - The message to log
     * @param {Object} args - Additional data to log
     */
    debug(message, args) {
        if (!Statamic.$config.get('collaboration.debug')) return;
        console.log(`[Collaboration ${this.windowId?.slice(-6) || 'init'}]`, message, { ...args });
    }

    /**
     * Fetch with timeout wrapper.
     * Aborts the request if it takes longer than apiTimeout (4 seconds).
     * @param {string} url - The URL to fetch
     * @param {Object} options - Fetch options
     * @returns {Promise<Response>} The fetch response
     */
    async fetchWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            return response;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Check if this window is alone (no other users or windows).
     * Used to skip broadcasts when they're not needed.
     * @returns {boolean} True if this is the only window
     */
    isAlone() {
        // Always assume not alone during warm-up (windows may still be joining)
        if (this.warmUpPeriod) {
            this.debug('isAlone: in warm-up period, returning false');
            return false;
        }

        const users = Statamic.$store.state.collaboration[this.channelName]?.users || [];
        const multipleUsers = users.length > 1;
        const multipleRemoteWindows = this.activeWindows.size > 1;
        const multipleLocalWindows = this.localWindows.size > 0;

        const alone = !multipleUsers && !multipleRemoteWindows && !multipleLocalWindows;

        this.debug(`isAlone: users=${users.length}, remoteWindows=${this.activeWindows.size}, localWindows=${this.localWindows.size}, alone=${alone}`);
        return alone;
    }

    /**
     * Send a whisper (broadcast) to other windows via WebSocket.
     * Automatically chunks large messages and skips if alone.
     * @param {string} event - The event name
     * @param {Object} payload - The data to send
     * @param {Object} options - Options (force: send even if alone)
     */
    whisper(event, payload, { force = false } = {}) {
        // Skip if alone (optimization), unless forced
        if (!force && this.isAlone()) return;

        const chunkSize = 2500;
        const str = JSON.stringify(payload);
        const msgId = Math.random() + '';

        // Small messages go directly
        if (str.length < chunkSize) {
            this.debug(`Broadcasting "${event}"`, payload);
            this.channel.whisper(event, payload);
            return;
        }

        // Large messages are chunked
        event = `chunked-${event}`;

        for (let i = 0; i * chunkSize < str.length; i++) {
            const chunk = {
                id: msgId,
                index: i,
                chunk: str.slice(i * chunkSize, (i + 1) * chunkSize),
                final: chunkSize * (i + 1) >= str.length
            };
            this.debug(`Broadcasting "${event}" chunk ${i}`, chunk);
            this.channel.whisper(event, chunk);
        }
    }

    /**
     * Listen for whispers with automatic chunk reassembly.
     * @param {string} event - The event name to listen for
     * @param {Function} callback - Handler for complete messages
     */
    listenForWhisper(event, callback) {
        // Listen for direct messages
        this.channel.listenForWhisper(event, callback);

        // Listen for chunked messages and reassemble
        let events = {};
        this.channel.listenForWhisper(`chunked-${event}`, data => {
            if (!events.hasOwnProperty(data.id)) {
                events[data.id] = { chunks: [], receivedFinal: false };
            }

            let e = events[data.id];
            e.chunks[data.index] = data.chunk;
            if (data.final) e.receivedFinal = true;

            // Check if all chunks received
            if (e.receivedFinal && e.chunks.length === Object.keys(e.chunks).length) {
                callback(JSON.parse(e.chunks.join('')));
                delete events[data.id];
            }
        });
    }

    /**
     * Play an audio notification.
     * @param {string} file - 'buddy-in' or 'buddy-out'
     */
    playAudio(file) {
        const audioFiles = { 'buddy-in': buddyIn, 'buddy-out': buddyOut };
        const el = document.createElement('audio');
        el.src = audioFiles[file];
        el.volume = 0.25;
        el.addEventListener('ended', () => el.remove());
        document.body.appendChild(el);
        el.play();
    }

    /**
     * Initialize lastValues and lastMetaValues caches with current state.
     * Also stores original values for change detection.
     */
    initializeValuesAndMeta() {
        this.lastValues = clone(Statamic.$store.state.publish[this.container.name].values);
        this.lastMetaValues = clone(Statamic.$store.state.publish[this.container.name].meta);

        Statamic.$store.commit(
            `collaboration/${this.channelName}/setOriginalValues`,
            clone(this.lastValues)
        );
    }

    /**
     * Load cached state from the server.
     * Applies values and meta to the Vuex store.
     * @param {string} source - Identifier for debugging (where this was called from)
     */
    async loadCachedState(source = 'unknown') {
        // Prevent concurrent calls
        if (this.loadingCachedState) {
            this.debug(`loadCachedState already in progress, skipping call from: ${source}`);
            return;
        }

        // Protect recent local changes (except when unlocking)
        if (source !== 'before-unlock') {
            const timeSinceLastChange = Date.now() - this.lastLocalChangeTime;
            if (timeSinceLastChange < this.localChangeProtectionMs) {
                this.debug(`Skipping loadCachedState (${source}) - local change was ${timeSinceLastChange}ms ago`);
                return;
            }
        }

        this.loadingCachedState = true;
        this.debug(`loadCachedState called from: ${source}`);

        // Prevent re-broadcasting while applying external data
        this.applyingBroadcast = true;

        try {
            const response = await this.fetchWithTimeout(this.stateApiUrl, {
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

            this.debug('Applying cached state from server', {
                valuesKeys: data.values ? Object.keys(data.values) : [],
                metaKeys: data.meta ? Object.keys(data.meta) : []
            });

            // Apply cached values
            if (data.values && Object.keys(data.values).length > 0) {
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues, ...data.values };

                Statamic.$store.commit(`publish/${this.container.name}/setValues`, mergedValues);

                // Update cache to prevent re-sending
                Object.keys(data.values).forEach(handle => {
                    this.lastValues[handle] = clone(data.values[handle]);
                });
            }

            // Apply cached meta (full replacement for assets to display correctly)
            if (data.meta && Object.keys(data.meta).length > 0) {
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const mergedMeta = { ...currentMeta };
                Object.keys(data.meta).forEach(handle => {
                    mergedMeta[handle] = data.meta[handle];
                });

                Statamic.$store.commit(`publish/${this.container.name}/setMeta`, mergedMeta);

                // Update cache to prevent re-sending
                Object.keys(data.meta).forEach(handle => {
                    this.lastMetaValues[handle] = clone(data.meta[handle]);
                });
            }
        } catch (error) {
            this.debug('Failed to load cached state', { error });
        } finally {
            this.applyingBroadcast = false;
            this.loadingCachedState = false;
        }
    }

    /**
     * Send full state update to the server.
     * @param {Object} values - All field values
     * @param {Object} meta - All field meta
     */
    async sendFullStateUpdate(values, meta) {
        this.debug('Sending full state update to server', {
            valuesKeys: Object.keys(values || {}),
            metaKeys: Object.keys(meta || {}),
        });

        const response = await this.fetchWithTimeout(this.stateApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-TOKEN': this.csrfToken,
            },
            credentials: 'same-origin',
            body: JSON.stringify({ values, meta, full: true }),
        });

        if (!response.ok) {
            this.debug('Failed to send state update', { status: response.status });
            throw new Error(`HTTP ${response.status}`);
        }

        this.debug('State update sent successfully');
    }

    /**
     * Clear cached state from the server.
     * Called after successful save.
     */
    async clearCachedState() {
        try {
            await this.fetchWithTimeout(this.stateApiUrl, {
                method: 'DELETE',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': this.csrfToken,
                },
                credentials: 'same-origin',
            });

            this.debug('Cleared cached state from server');
        } catch (error) {
            this.debug('Failed to clear cached state', { error });
        }
    }

    /**
     * Reset the session inactivity timer (12 hour warning).
     */
    resetActivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }

        this.inactivityWarningShown = false;

        this.inactivityTimer = setTimeout(() => {
            this.showInactivityWarning();
        }, this.inactivityTimeout);

        this.debug('Activity timer reset');
    }

    /**
     * Clear the session inactivity timer.
     */
    clearActivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    /**
     * Show inactivity warning after 12 hours.
     * Prompts user to close the entry to avoid conflicts.
     */
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
            window.location.href = Statamic.$config.get('cpUrl') || '/cp';
        });

        this.debug('Inactivity warning shown after 12 hours');
    }
}
