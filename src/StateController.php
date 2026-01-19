<?php

namespace Statamic\Collaboration;

use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

/**
 * StateController - Server-side state persistence for collaboration
 *
 * This controller handles caching of entry state between browser windows.
 * Data flows through here (not WebSocket) to ensure consistency.
 *
 * Endpoints:
 * - GET:    Retrieve cached state for an entry
 * - POST:   Update a single field's value or meta
 * - DELETE: Clear cached state (called on save)
 */
class StateController extends Controller
{
    /**
     * Cache TTL in seconds (24 hours)
     */
    protected int $ttl = 86400;

    /**
     * Get the cached state for an entry.
     */
    public function show(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEdit($reference)) {
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
     * Update a single field's value or meta in the cache.
     */
    public function update(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEdit($reference)) {
            abort(403);
        }

        $validated = $request->validate([
            'handle' => 'required|string',
            'value' => 'present',
            'type' => 'required|in:value,meta',
        ]);

        $key = $this->cacheKey($reference, $site);
        $state = Cache::get($key, ['values' => [], 'meta' => []]);

        if ($validated['type'] === 'value') {
            // Store the value directly
            $state['values'][$validated['handle']] = $validated['value'];
        } else {
            // For meta, deep merge to preserve nested properties (like image URLs)
            $existing = $state['meta'][$validated['handle']] ?? [];
            $incoming = $validated['value'] ?? [];
            $state['meta'][$validated['handle']] = array_replace_recursive($existing, $incoming);
        }

        Cache::put($key, $state, $this->ttl);

        return response()->json(['success' => true]);
    }

    /**
     * Clear the cached state for an entry (called on save/publish).
     */
    public function destroy(Request $request, string $reference, string $site)
    {
        if (!$this->userCanEdit($reference)) {
            abort(403);
        }

        $key = $this->cacheKey($reference, $site);
        Cache::forget($key);

        return response()->json(['success' => true]);
    }

    /**
     * Check if the current user has permission to edit.
     */
    protected function userCanEdit(string $reference): bool
    {
        $guard = config('statamic.users.guards.cp', 'web');
        return Auth::guard($guard)->check();
    }

    /**
     * Generate a cache key for the entry state.
     */
    protected function cacheKey(string $reference, string $site): string
    {
        // Normalize the reference (replace . back to :: for consistency)
        $normalized = str_replace('.', '::', $reference);
        return "collaboration.state.{$normalized}.{$site}";
    }
}
