import Manager from './Manager';
import StatusBar from './StatusBar.vue';
import BlockingNotification from './BlockingNotification.vue';
const manager = new Manager;

Statamic.booting(() => {
    Statamic.component('CollaborationStatusBar', StatusBar);
    Statamic.component('CollaborationBlockingNotification', BlockingNotification);

    Statamic.$store.registerModule('collaboration', {
        namespaced: true
    });
});

Statamic.$echo.booted(Echo => {
    manager.echo = Echo;
    manager.boot();
});

Statamic.$events.$on('publish-container-created', container => {
    if (!container.reference) return;
    manager.addWorkspace(container);

    // Use pagehide instead of deprecated unload event
    // pagehide fires reliably when navigating away and is the modern replacement
    const cleanup = () => manager.destroyWorkspace(container);
    window.addEventListener('pagehide', cleanup, { once: true });
});

Statamic.$events.$on('publish-container-destroyed', container => {
    if (!manager.workspaces[container.name]) return;
    manager.destroyWorkspace(container);
});
