/**
 * Workspace - Real-time collaboration for Statamic entries
 *
 * Architecture:
 * - Data flows through the server (StateController), not WebSocket
 * - Pusher/WebSocket only used for lightweight notifications
 * - Each browser tab has a unique windowId to filter own messages
 *
 * Sync flow:
 * 1. User edits a field
 * 2. On blur OR 5 seconds inactivity, changes are persisted to server
 * 3. After persist, a notification is sent via Pusher (field handle only)
 * 4. Other windows receive notification and fetch data from server
 * 5. Data is applied with field locking to prevent conflicts
 */

export default class Workspace {

    constructor(container) {
        this.container = container;
        this.echo = null;
        this.channel = null;
        this.channelName = null;
        this.started = false;
        this.storeSubscriber = null;

        // User info
        this.user = Statamic.user;

        // Unique ID for this browser tab
        this.windowId = this.generateWindowId();

        // Server API URL for state persistence
        this.stateApiUrl = null;

        // Track last known values to detect changes
        this.lastValues = {};
        this.lastMeta = {};

        // Track which field the user is currently editing
        this.currentFocus = null;

        // Inactivity timer for auto-sync (5 seconds)
        this.inactivityTimer = null;
        this.inactivityDelayMs = 5000;

        // Field lock duration after blur (3 seconds)
        this.fieldLockDurationMs = 3000;
        this.fieldLockTimers = {};

        // Prevent re-broadcasting received changes
        this.applyingRemoteChange = false;

        // Track fields currently locked by other users
        this.lockedFields = {};
    }

    /**
     * Generate a unique ID for this browser tab
     */
    generateWindowId() {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2, 8);
        return `${timestamp}-${random}`;
    }

    /**
     * Start the collaboration workspace
     */
    start() {
        if (this.started) return;

        this.initializeStateApi();
        this.initializeChannel();
        this.initializeStore();
        this.initializeFocus();
        this.initializeHooks();
        this.initializeStatusBar();
        this.loadInitialState();

        this.started = true;
        this.debug('Workspace started');
    }

    /**
     * Clean up when workspace is destroyed
     */
    destroy() {
        // Notify others that we're leaving
        this.channel?.whisper('window-left', {
            windowId: this.windowId,
            user: this.user
        });

        // Clear timers
        this.clearInactivityTimer();
        Object.values(this.fieldLockTimers).forEach(timer => clearTimeout(timer));

        // Unsubscribe from store
        if (this.storeSubscriber) {
            this.storeSubscriber();
        }

        // Leave channel
        if (this.echo && this.channelName) {
            this.echo.leave(this.channelName);
        }

        this.debug('Workspace destroyed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Set up the server API URL for state persistence
     */
    initializeStateApi() {
        const reference = this.container.reference.replaceAll('::', '.');
        const site = this.container.site.replaceAll('.', '_');
        const cpUrl = Statamic.$config.get('cpUrl') || '/cp';
        this.stateApiUrl = `${cpUrl}/collaboration/state/${reference}/${site}`;
    }

    /**
     * Set up WebSocket channel for notifications
     */
    initializeChannel() {
        const reference = this.container.reference.replaceAll('::', '.');
        this.channelName = `${reference}.${this.container.site.replaceAll('.', '_')}`;
        this.channel = this.echo.join(this.channelName);

        // When we join, get list of users and announce ourselves
        this.channel.here(users => {
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);
            this.channel.whisper('window-joined', {
                windowId: this.windowId,
                user: this.user
            });
        });

        // User joined the channel
        this.channel.joining(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/addUser`, user);
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has joined.`, { duration: 2000 });
            }
        });

        // User left the channel
        this.channel.leaving(user => {
            Statamic.$store.commit(`collaboration/${this.channelName}/removeUser`, user);
            if (user.id !== this.user.id) {
                Statamic.$toast.info(`${user.name} has left.`, { duration: 2000 });
            }
            // Unlock any fields they had locked
            this.unlockFieldsForUser(user);
        });

        // Listen for field change notifications
        this.channel.listenForWhisper('field-changed', ({ windowId, handle }) => {
            // Ignore our own notifications
            if (windowId === this.windowId) return;

            // Ignore if this field is locked by us
            if (this.currentFocus === handle) return;

            this.debug(`Field "${handle}" changed by another window, fetching...`);
            this.fetchAndApplyField(handle);
        });

        // Listen for focus events (field locking)
        this.channel.listenForWhisper('focus', ({ windowId, user, handle }) => {
            if (windowId === this.windowId) return;
            if (user.id === this.user.id) return; // Don't lock for our own other windows

            this.lockField(user, handle);
        });

        // Listen for blur events (field unlocking after delay)
        this.channel.listenForWhisper('blur', ({ windowId, user, handle }) => {
            if (windowId === this.windowId) return;
            if (user.id === this.user.id) return;

            // Unlock after 3 seconds
            this.scheduleFieldUnlock(user, handle);
        });

        // Listen for save notifications
        this.channel.listenForWhisper('saved', ({ windowId, user }) => {
            if (windowId === this.windowId) return;
            Statamic.$toast.success(`Saved by ${user.name}.`, { duration: 2000 });
            // Fetch all state after save
            this.fetchAllState();
        });

        // Listen for publish notifications
        this.channel.listenForWhisper('published', ({ windowId, user }) => {
            if (windowId === this.windowId) return;
            Statamic.$toast.success(`Published by ${user.name}.`);
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: `Entry has been published by ${user.name}. Please refresh.` }
            }).on('confirm', () => window.location.reload());
        });
    }

    /**
     * Set up Vuex store module for collaboration state
     */
    initializeStore() {
        Statamic.$store.registerModule(['collaboration', this.channelName], {
            namespaced: true,
            state: {
                users: [],
                focus: {},
            },
            mutations: {
                setUsers(state, users) {
                    state.users = users;
                },
                addUser(state, user) {
                    state.users.push(user);
                },
                removeUser(state, user) {
                    state.users = state.users.filter(u => u.id !== user.id);
                },
                setFocus(state, { user, handle }) {
                    Vue.set(state.focus, user.id, { user, handle });
                },
                clearFocus(state, user) {
                    Vue.delete(state.focus, user.id);
                }
            }
        });

        // Subscribe to Vuex mutations to detect field changes
        this.storeSubscriber = Statamic.$store.subscribe((mutation) => {
            if (this.applyingRemoteChange) return;

            if (mutation.type === `publish/${this.container.name}/setFieldValue`) {
                this.onFieldValueChanged(mutation.payload);
            }
            if (mutation.type === `publish/${this.container.name}/setFieldMeta`) {
                this.onFieldMetaChanged(mutation.payload);
            }
        });

        // Store initial values for change detection
        this.lastValues = clone(Statamic.$store.state.publish[this.container.name].values);
        this.lastMeta = clone(Statamic.$store.state.publish[this.container.name].meta);
    }

    /**
     * Set up focus/blur tracking for fields
     */
    initializeFocus() {
        this.container.$on('focus', handle => {
            this.currentFocus = handle;
            this.channel.whisper('focus', {
                windowId: this.windowId,
                user: this.user,
                handle
            });
            Statamic.$store.commit(`collaboration/${this.channelName}/setFocus`, {
                user: this.user,
                handle
            });
        });

        this.container.$on('blur', handle => {
            this.currentFocus = null;
            this.channel.whisper('blur', {
                windowId: this.windowId,
                user: this.user,
                handle
            });
            Statamic.$store.commit(`collaboration/${this.channelName}/clearFocus`, this.user);

            // Sync changes when leaving a field
            this.syncChangedFields();
        });
    }

    /**
     * Set up hooks for save/publish events
     */
    initializeHooks() {
        Statamic.$hooks.on('entry.saved', (resolve, reject, { reference }) => {
            if (reference === this.container.reference) {
                // Clear server cache and notify others
                this.clearServerState();
                this.channel.whisper('saved', {
                    windowId: this.windowId,
                    user: this.user
                });
            }
            resolve();
        });

        Statamic.$hooks.on('entry.published', (resolve, reject, { reference }) => {
            if (reference === this.container.reference) {
                this.channel.whisper('published', {
                    windowId: this.windowId,
                    user: this.user
                });
            }
            resolve();
        });
    }

    /**
     * Add collaboration status bar to the publish form
     */
    initializeStatusBar() {
        const component = this.container.pushComponent('CollaborationStatusBar', {
            props: { channelName: this.channelName }
        });

        component.on('unlock', (targetUser) => {
            this.channel.whisper('force-unlock', {
                targetUser,
                originUser: this.user
            });
        });
    }

    /**
     * Load any existing state from server on startup
     */
    async loadInitialState() {
        await this.fetchAllState();
    }

    // =========================================================================
    // CHANGE DETECTION & SYNC
    // =========================================================================

    /**
     * Called when a field value changes in Vuex
     */
    onFieldValueChanged(payload) {
        const { handle, value } = payload;

        // Check if value actually changed
        if (JSON.stringify(this.lastValues[handle]) === JSON.stringify(value)) {
            return;
        }

        this.lastValues[handle] = clone(value);
        this.debug(`Field "${handle}" value changed`);

        // Reset inactivity timer
        this.resetInactivityTimer();
    }

    /**
     * Called when field meta changes in Vuex
     */
    onFieldMetaChanged(payload) {
        const { handle, value } = payload;

        // Check if meta actually changed
        if (JSON.stringify(this.lastMeta[handle]) === JSON.stringify(value)) {
            return;
        }

        this.lastMeta[handle] = clone(value);
        this.debug(`Field "${handle}" meta changed`);

        // Reset inactivity timer
        this.resetInactivityTimer();
    }

    /**
     * Reset the inactivity timer (syncs after 5 seconds of no changes)
     */
    resetInactivityTimer() {
        this.clearInactivityTimer();
        this.inactivityTimer = setTimeout(() => {
            this.syncChangedFields();
        }, this.inactivityDelayMs);
    }

    /**
     * Clear the inactivity timer
     */
    clearInactivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    /**
     * Sync all changed fields to server and notify others
     */
    async syncChangedFields() {
        this.clearInactivityTimer();

        const currentValues = Statamic.$store.state.publish[this.container.name].values;
        const currentMeta = Statamic.$store.state.publish[this.container.name].meta;

        // Find changed values
        const changedHandles = new Set();

        for (const handle of Object.keys(currentValues)) {
            if (JSON.stringify(currentValues[handle]) !== JSON.stringify(this.lastValues[handle])) {
                changedHandles.add(handle);
            }
        }

        for (const handle of Object.keys(currentMeta)) {
            if (JSON.stringify(currentMeta[handle]) !== JSON.stringify(this.lastMeta[handle])) {
                changedHandles.add(handle);
            }
        }

        if (changedHandles.size === 0) {
            return;
        }

        this.debug(`Syncing ${changedHandles.size} changed field(s)...`);

        // Persist each changed field to server
        for (const handle of changedHandles) {
            if (currentValues[handle] !== undefined) {
                await this.persistField(handle, currentValues[handle], 'value');
            }
            if (currentMeta[handle] !== undefined) {
                await this.persistField(handle, currentMeta[handle], 'meta');
            }

            // Notify others to fetch this field
            this.channel.whisper('field-changed', {
                windowId: this.windowId,
                handle
            });
        }

        // Update our tracking
        this.lastValues = clone(currentValues);
        this.lastMeta = clone(currentMeta);
    }

    // =========================================================================
    // SERVER COMMUNICATION
    // =========================================================================

    /**
     * Persist a single field to the server
     */
    async persistField(handle, value, type) {
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

            this.debug(`Persisted ${type} for "${handle}"`);
        } catch (error) {
            this.debug(`Failed to persist ${type} for "${handle}"`, error);
        }
    }

    /**
     * Fetch all state from server and apply it
     */
    async fetchAllState() {
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
            if (!data.exists) return;

            this.applyState(data.values, data.meta);
        } catch (error) {
            this.debug('Failed to fetch state', error);
        }
    }

    /**
     * Fetch a specific field from server and apply it
     */
    async fetchAndApplyField(handle) {
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
            if (!data.exists) return;

            // Apply only the specific field
            const values = data.values?.[handle] !== undefined ? { [handle]: data.values[handle] } : null;
            const meta = data.meta?.[handle] !== undefined ? { [handle]: data.meta[handle] } : null;

            this.applyState(values, meta);
        } catch (error) {
            this.debug(`Failed to fetch field "${handle}"`, error);
        }
    }

    /**
     * Apply state from server to Vuex store
     */
    applyState(values, meta) {
        this.applyingRemoteChange = true;

        try {
            if (values && Object.keys(values).length > 0) {
                const currentValues = Statamic.$store.state.publish[this.container.name].values;
                const mergedValues = { ...currentValues };

                for (const handle of Object.keys(values)) {
                    // Skip if this field is currently being edited by us
                    if (this.currentFocus === handle) {
                        this.debug(`Skipping "${handle}" - currently editing`);
                        continue;
                    }
                    mergedValues[handle] = values[handle];
                    this.lastValues[handle] = clone(values[handle]);
                }

                Statamic.$store.commit(`publish/${this.container.name}/setValues`, mergedValues);
            }

            if (meta && Object.keys(meta).length > 0) {
                const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                const mergedMeta = { ...currentMeta };

                for (const handle of Object.keys(meta)) {
                    // Skip if this field is currently being edited by us
                    if (this.currentFocus === handle) {
                        this.debug(`Skipping meta for "${handle}" - currently editing`);
                        continue;
                    }
                    mergedMeta[handle] = { ...currentMeta[handle], ...meta[handle] };
                    this.lastMeta[handle] = clone(mergedMeta[handle]);
                }

                Statamic.$store.commit(`publish/${this.container.name}/setMeta`, mergedMeta);
            }
        } finally {
            this.applyingRemoteChange = false;
        }
    }

    /**
     * Clear all cached state from server (called on save)
     */
    async clearServerState() {
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

            this.debug('Cleared server state');
        } catch (error) {
            this.debug('Failed to clear server state', error);
        }
    }

    // =========================================================================
    // FIELD LOCKING
    // =========================================================================

    /**
     * Lock a field (another user is editing it)
     */
    lockField(user, handle) {
        this.lockedFields[handle] = user;
        Statamic.$store.commit(`publish/${this.container.name}/lockField`, { user, handle });
        Statamic.$store.commit(`collaboration/${this.channelName}/setFocus`, { user, handle });
        this.debug(`Field "${handle}" locked by ${user.name}`);
    }

    /**
     * Schedule a field to be unlocked after 3 seconds
     */
    scheduleFieldUnlock(user, handle) {
        // Clear any existing timer for this field
        if (this.fieldLockTimers[handle]) {
            clearTimeout(this.fieldLockTimers[handle]);
        }

        this.fieldLockTimers[handle] = setTimeout(() => {
            this.unlockField(user, handle);
            delete this.fieldLockTimers[handle];
        }, this.fieldLockDurationMs);
    }

    /**
     * Unlock a field
     */
    unlockField(user, handle) {
        delete this.lockedFields[handle];
        Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
        Statamic.$store.commit(`collaboration/${this.channelName}/clearFocus`, user);
        this.debug(`Field "${handle}" unlocked`);
    }

    /**
     * Unlock all fields for a user (when they leave)
     */
    unlockFieldsForUser(user) {
        for (const [handle, lockedUser] of Object.entries(this.lockedFields)) {
            if (lockedUser.id === user.id) {
                this.unlockField(user, handle);
            }
        }
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    /**
     * Debug logging (only when enabled in config)
     */
    debug(message, data = null) {
        if (!Statamic.$config.get('collaboration.debug')) return;
        const prefix = `[Collab ${this.windowId.slice(-6)}]`;
        if (data) {
            console.log(prefix, message, data);
        } else {
            console.log(prefix, message);
        }
    }
}

/**
 * Deep clone helper
 */
function clone(obj) {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
}
