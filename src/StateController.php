<?php

namespace Statamic\Collaboration;

use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

class StateController extends Controller
{
    /**
     * Cache TTL in seconds (24 hours - states expire after no activity)
     */
    protected int $ttl = 44000;

    /**
     * Get the cached state for an entry.
     */
    public function show(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEditEntry($reference)) {
            abort(403);
        }

        $key = $this->cacheKey($reference, $site);

        $state = Cache::get($key);

        if (!$state) {
            return response()->json([
                'exists' => false,
                'values' => null,
                'meta' => null,
            ]);
        }

        return response()->json([
            'exists' => true,
            'values' => $state['values'] ?? [],
            'meta' => $state['meta'] ?? [],
        ]);
    }

    /**
     * Update the cached state for an entry.
     */
    public function update(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEditEntry($reference)) {
            abort(403);
        }

        $key = $this->cacheKey($reference, $site);

        // Handle full state update (all values and meta at once)
        if ($request->boolean('full')) {
            $state = [
                'values' => $request->input('values', []),
                'meta' => $request->input('meta', []),
            ];
            Cache::put($key, $state, $this->ttl);
            return response()->json(['success' => true]);
        }

        // Handle single field update (legacy)
        $validated = $request->validate([
            'handle' => 'required|string',
            'value' => 'present',
            'type' => 'required|in:value,meta',
        ]);

        $state = Cache::get($key, ['values' => [], 'meta' => []]);

        if ($validated['type'] === 'value') {
            $state['values'][$validated['handle']] = $validated['value'];
        } else {
            // For meta, use array_replace_recursive to deep merge nested structures
            // This preserves image URLs, cached data, and other nested properties
            $existingMeta = $state['meta'][$validated['handle']] ?? [];
            $newMeta = $validated['value'] ?? [];
            $state['meta'][$validated['handle']] = array_replace_recursive($existingMeta, $newMeta);
        }

        Cache::put($key, $state, $this->ttl);

        return response()->json(['success' => true]);
    }

    /**
     * Clear the cached state for an entry (called on save/publish).
     */
    public function destroy(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEditEntry($reference)) {
            abort(403);
        }

        $key = $this->cacheKey($reference, $site);

        Cache::forget($key);

        return response()->json(['success' => true]);
    }

    /**
     * Check if the current user has access.
     */
    protected function userCanEditEntry(string $reference): bool
    {
        // Get user from the CP guard
        $guard = config('statamic.users.guards.cp', 'web');
        $authUser = Auth::guard($guard)->user();

        if (!$authUser) {
            return false;
        }

        return true;
    }

    /**
     * Generate a cache key for the entry state.
     */
    protected function cacheKey(string $reference, string $site): string
    {
        // Normalize the reference (replace . back to :: for consistency)
        $normalizedRef = str_replace('.', '::', $reference);

        return "collaboration.state.{$normalizedRef}.{$site}";
    }
}
