<template>
    <div v-if="hasUnsavedChanges" class="collaboration-temporary-changes-notification">
        <div class="flex items-center justify-between p-3 mb-4 bg-yellow-100 border border-yellow-300 rounded-md text-yellow-800">
            <div class="flex items-center">
                <svg class="w-5 h-5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
                <span class="text-sm font-medium">
                    {{ currentMessage }}
                </span>
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
        },
        newEntryMessage: {
            type: String,
            default: 'New entry — changes are stored temporarily and have not been saved to the database.'
        },
        unsavedChangesMessage: {
            type: String,
            default: 'Unsaved changes — these changes are stored temporarily and have not been saved to the database.'
        }
    },

    computed: {
        saveStatus() {
            const state = this.$store.state.collaboration[this.channelName];
            return state?.saveStatus;
        },

        hasUnsavedChanges() {
            return this.saveStatus === 'notSaved' || this.saveStatus === 'changesNotSaved';
        },

        currentMessage() {
            return this.saveStatus === 'notSaved'
                ? this.newEntryMessage
                : this.unsavedChangesMessage;
        }
    }
}
</script>
