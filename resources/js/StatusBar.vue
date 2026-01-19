<template>

    <div class="collaboration-status-bar" :class="{ '-mt-2 mb-2': connecting || users.length > 1 }">
        <loading-graphic v-if="connecting" :inline="true" :size="16" text="Attempting websocket connection..." />
        <div v-if="users.length > 1" class="flex items-center">
            <div
                v-for="user in users"
                :key="user.id"
            >
                <dropdown-list>
                    <template v-slot:trigger>
                        <avatar
                            :user="user"
                            class="rounded-full w-6 h-6 mr-1 cursor-pointer text-xs"
                        />
                    </template>
                    <dropdown-item text="Unlock" @click="$emit('unlock', user)" />
                </dropdown-list>
            </div>
        </div>
    </div>

</template>

<script>
export default {
    name: 'CollaborationStatusBar',

    props: {
        channelName: {
            type: String,
            required: true,
        }
    },

    data() {
        return {
            ready: false
        };
    },

    mounted() {
        this.ready = true;
    },

    computed: {
        collaborationState() {
            // Defensive check: store or collaboration module might not be ready yet
            if (!this.ready || !this.$store?.state?.collaboration || !this.channelName) {
                return null;
            }
            return this.$store.state.collaboration[this.channelName] || null;
        },
        users() {
            if (!this.collaborationState) return [];
            return this.collaborationState.users || [];
        },
        connecting() {
            return this.users.length === 0;
        }
    }
}
</script>

<style>
    .collaboration-status-bar .dropdown-menu { left: 0; }
</style>
