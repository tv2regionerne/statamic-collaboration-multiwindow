<template>

    <div class="collaboration-status-bar" :class="{ '-mt-2 mb-2': showStatusBar }">
        <!-- Save status indicator -->
        <div v-if="saveStatus !== 'saved'" class="save-status-notice mb-3 p-3 rounded-md" :class="saveStatusClasses">
            <div class="flex items-center">
                <svg class="w-5 h-5 mr-2 flex-shrink-0" :class="saveStatusIconClass" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path v-if="saveStatus === 'notSaved'" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                    <span class="font-semibold" :class="saveStatusTitleClass">{{ saveStatusTitle }}</span>
                    <span class="ml-1" :class="saveStatusTextClass">{{ saveStatusMessage }}</span>
                </div>
            </div>
        </div>

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

    props: {
        container: {
            required: true,
        },
        channelName: {
            type: String,
            required: true,
        }
    },

    computed: {
        users() {
            return this.$store.state.collaboration[this.channelName].users;
        },
        connecting() {
            return this.users.length === 0;
        },
        saveStatus() {
            return this.$store.state.collaboration[this.channelName].saveStatus || 'saved';
        },
        showStatusBar() {
            return this.saveStatus !== 'saved' || this.connecting || this.users.length > 1;
        },
        saveStatusClasses() {
            return {
                'bg-amber-100 dark:bg-amber-900 border border-amber-300 dark:border-amber-700': this.saveStatus === 'notSaved',
                'bg-orange-100 dark:bg-orange-900 border border-orange-300 dark:border-orange-700': this.saveStatus === 'changesNotSaved',
            };
        },
        saveStatusIconClass() {
            return {
                'text-amber-600 dark:text-amber-400': this.saveStatus === 'notSaved',
                'text-orange-600 dark:text-orange-400': this.saveStatus === 'changesNotSaved',
            };
        },
        saveStatusTitleClass() {
            return {
                'text-amber-800 dark:text-amber-200': this.saveStatus === 'notSaved',
                'text-orange-800 dark:text-orange-200': this.saveStatus === 'changesNotSaved',
            };
        },
        saveStatusTextClass() {
            return {
                'text-amber-700 dark:text-amber-300': this.saveStatus === 'notSaved',
                'text-orange-700 dark:text-orange-300': this.saveStatus === 'changesNotSaved',
            };
        },
        saveStatusTitle() {
            switch (this.saveStatus) {
                case 'notSaved': return 'Not saved';
                case 'changesNotSaved': return 'Changes not saved';
                default: return '';
            }
        },
        saveStatusMessage() {
            switch (this.saveStatus) {
                case 'notSaved': return '— This entry has not been saved yet. Changes are temporarily stored for up to 12 hours.';
                case 'changesNotSaved': return '— You have unsaved changes. Changes are temporarily stored for up to 12 hours.';
                default: return '';
            }
        }
    }

}
</script>

<style>
    .collaboration-status-bar .dropdown-menu { left: 0; }
</style>
