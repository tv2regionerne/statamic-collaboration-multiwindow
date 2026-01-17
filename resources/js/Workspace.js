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

        this.debouncedBroadcastValueChangeFuncsByHandle = {};
        this.debouncedBroadcastMetaChangeFuncsByHandle = {};
        this.debouncedPersistValueFuncsByHandle = {};
        this.debouncedPersistMetaFuncsByHandle = {};
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
        this.started = true;
    }

    initializeVisibilityHandler() {
        this.visibilityHandler = async () => {
            if (document.visibilityState === 'visible') {
                this.debug('👁️ Window became visible, syncing state...');
                await this.loadCachedState();
                // Re-announce ourselves to get fresh state from other windows
                this.channel.whisper('window-joined', { windowId: this.windowId, user: this.user });
            }
        };

        document.addEventListener('visibilitychange', this.visibilityHandler);
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

        this.channel.here(async users => {
            this.subscribeToVuexMutations();
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);

            // Register our own window
            this.activeWindows.add(this.windowId);

            // Start inactivity timer
            this.resetActivityTimer();

            // Always load cached state first (handles reconnects and stale data)
            await this.loadCachedState();

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
        this.channel.listenForWhisper(`initialize-state-for-window-${this.windowId}`, payload => {
            this.debug('✅ Applying/merging state from another window', payload);

            // Merge values with current state
            const currentValues = Statamic.$store.state.publish[this.container.name].values;
            const mergedValues = { ...currentValues, ...payload.values };
            Statamic.$store.dispatch(`publish/${this.container.name}/setValues`, mergedValues);

            // Merge meta with current state
            const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
            const restoredMeta = this.restoreEntireMetaPayload(payload.meta);
            const mergedMeta = { ...currentMeta };
            Object.keys(restoredMeta).forEach(handle => {
                mergedMeta[handle] = { ...currentMeta[handle], ...restoredMeta[handle] };
            });
            Statamic.$store.dispatch(`publish/${this.container.name}/setMeta`, mergedMeta);

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
                Statamic.$toast.success(`${user.name} has joined.`);
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
                Statamic.$toast.success(`${user.name} has left.`);
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
            if (windowId === this.windowId) return;

            this.debug(`📥 Fetching ${type} for "${handle}" from server (large payload)`);
            this.loadCachedState(); // Reload all state from server
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
                removeUser(state, removedUser) {
                    state.users = state.users.filter(user => user.id !== removedUser.id);
                },
                focus(state, { handle, user }) {
                    Vue.set(state.focus, user.id, { handle, user });
                },
                blur(state, user) {
                    Vue.delete(state.focus, user.id);
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
        this.debug('Vuex field value has been set', payload);
        if (!this.valueHasChanged(payload.handle, payload.value)) {
            // No change? Don't bother doing anything.
            this.debug(`Value for ${payload.handle} has not changed.`, { value: payload.value, lastValue: this.lastValues[payload.handle] });
            return;
        }

        this.rememberValueChange(payload.handle, payload.value);

        // Reset inactivity timer on any change
        this.resetActivityTimer();

        // Only broadcast and persist if this change originated from THIS window
        if (!this.applyingBroadcast) {
            this.debouncedBroadcastValueChangeFuncByHandle(payload.handle)(payload);

            // Persist to server cache (only for our own changes from this window)
            if (this.user.id == payload.user) {
                this.persistValueChange(payload.handle, payload.value);
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

    async broadcastValueChange(payload) {
        // Only broadcast if this change originated from THIS window (not from a broadcast we received)
        if (this.applyingBroadcast) return;

        // Only my own change events should be broadcasted
        if (this.user.id == payload.user) {
            const fullPayload = { ...payload, windowId: this.windowId };

            // For large payloads (>3KB), persist immediately and notify others to fetch from server
            if (JSON.stringify(fullPayload).length > 3000) {
                this.debug(`📦 Large payload for "${payload.handle}", persisting and sending fetch notification`);
                // Wait for persist to complete before notifying others to fetch
                await this.sendStateUpdate(payload.handle, payload.value, 'value');
                this.channel.whisper('fetch-field', { handle: payload.handle, type: 'value', windowId: this.windowId });
            } else {
                this.whisper('updated', fullPayload);
            }
        }
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

    applyBroadcastedValueChange(payload) {
        // Ignore broadcasts from this same window
        if (payload.windowId === this.windowId) return;

        this.debug('✅ Applying broadcasted value change', payload);

        // Mark that we're applying a broadcast to prevent re-broadcasting
        this.applyingBroadcast = true;
        try {
            Statamic.$store.dispatch(`publish/${this.container.name}/setFieldValue`, payload);
        } finally {
            this.applyingBroadcast = false;
        }
    }

    applyBroadcastedMetaChange(payload) {
        // Ignore broadcasts from this same window
        if (payload.windowId === this.windowId) return;

        this.debug('✅ Applying broadcasted meta change', payload);

        let value = {...this.lastMetaValues[payload.handle], ...payload.value};
        payload.value = value;

        // Mark that we're applying a broadcast to prevent re-broadcasting
        this.applyingBroadcast = true;
        try {
            Statamic.$store.dispatch(`publish/${this.container.name}/setFieldMeta`, payload);
        } finally {
            this.applyingBroadcast = false;
        }
    }

    debug(message, args) {
        console.log('[Collaboration]', message, {...args});
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
    }

    async loadCachedState() {
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

            // Mark that we're applying external data to prevent re-broadcasting
            this.applyingBroadcast = true;
            try {
                // Apply cached values - merge with current values
                if (data.values && Object.keys(data.values).length > 0) {
                    const currentValues = Statamic.$store.state.publish[this.container.name].values;
                    const mergedValues = { ...currentValues, ...data.values };
                    Statamic.$store.dispatch(`publish/${this.container.name}/setValues`, mergedValues);
                }

                // Apply cached meta - merge with current meta
                if (data.meta && Object.keys(data.meta).length > 0) {
                    const currentMeta = Statamic.$store.state.publish[this.container.name].meta;
                    const mergedMeta = { ...currentMeta };
                    Object.keys(data.meta).forEach(handle => {
                        mergedMeta[handle] = { ...currentMeta[handle], ...data.meta[handle] };
                    });
                    Statamic.$store.dispatch(`publish/${this.container.name}/setMeta`, mergedMeta);
                }
            } finally {
                this.applyingBroadcast = false;
            }

            this.initialStateUpdated = true;
        } catch (error) {
            this.debug('Failed to load cached state', { error });
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
                title: 'Inaktivitet',
                message: 'Der har ikke været aktivitet i 12 timer. Luk venligst dette indhold for at undgå konflikter.',
                confirmText: 'Luk indhold'
            }
        }).on('confirm', () => {
            // Navigate away or close
            window.location.href = Statamic.$config.get('cpUrl') || '/cp';
        });

        this.debug('⚠️ Inactivity warning shown after 12 hours');
    }
}
