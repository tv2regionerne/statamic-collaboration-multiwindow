<template>

    <div class="collaboration-status-bar" :class="{ '-mt-2 mb-2': isConnecting || users.length > 1 }">
        <loading-graphic v-if="isConnecting" :inline="true" :size="16" text="Attempting websocket connection..." />
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

    props: {
        channelName: {
            type: String,
            required: true,
        }
    },

    data() {
        return {
            ready: false,
        };
    },

    mounted() {
        // Delay initialization to ensure store is ready
        this.$nextTick(() => {
            this.ready = true;
        });
    },

    computed: {
        collaborationState() {
            if (!this.ready) return null;
            if (!this.$store || !this.$store.state || !this.$store.state.collaboration) {
                return null;
            }
            return this.$store.state.collaboration[this.channelName] || null;
        },
        users() {
            if (!this.collaborationState || !this.collaborationState.users) {
                return [];
            }
            return this.collaborationState.users;
        },
        isConnecting() {
            if (!this.ready) return true;
            return this.users.length === 0;
        }
    }

}
</script>

<style>
    .collaboration-status-bar .dropdown-menu { left: 0; }
</style>
