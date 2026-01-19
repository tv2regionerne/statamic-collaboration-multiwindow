<template>
    <div class="collaboration-status-bar" :class="statusBarClass">
        <loading-graphic v-if="isConnecting" :inline="true" :size="16" text="Attempting websocket connection..." />
        <div v-if="hasMultipleUsers" class="flex items-center">
            <div
                v-for="user in userList"
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
        userList() {
            if (!this.collaborationState) return [];
            return this.collaborationState.users || [];
        },
        isConnecting() {
            return this.userList.length === 0;
        },
        hasMultipleUsers() {
            return this.userList.length > 1;
        },
        statusBarClass() {
            return {
                '-mt-2 mb-2': this.isConnecting || this.hasMultipleUsers
            };
        }
    }
}
</script>

<style>
    .collaboration-status-bar .dropdown-menu { left: 0; }
</style>
