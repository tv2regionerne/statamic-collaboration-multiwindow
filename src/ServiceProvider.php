<?php

namespace Statamic\Collaboration;

use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Route;
use Statamic\Facades\User;
use Statamic\Providers\AddonServiceProvider;
use Statamic\Statamic;

class ServiceProvider extends AddonServiceProvider
{
    protected $vite = [
        'input' => ['resources/js/collaboration.js'],
        'publicDirectory' => 'resources/dist',
        'hotFile' => __DIR__.'/../resources/dist/hot',
    ];

    public function bootAddon()
    {
        Statamic::provideToScript(['collaboration' => config('collaboration')]);

        $this->registerRoutes();
        $this->registerBroadcastChannel();
    }

    protected function registerRoutes()
    {
        Route::middleware(['web', 'statamic.cp.authenticated'])
            ->prefix(config('statamic.cp.route', 'cp'))
            ->group(function () {
                Route::get('collaboration/state/{reference}/{site}', [StateController::class, 'show'])
                    ->name('collaboration.state.show')
                    ->where('reference', '.*');

                Route::post('collaboration/state/{reference}/{site}', [StateController::class, 'update'])
                    ->name('collaboration.state.update')
                    ->where('reference', '.*');

                Route::delete('collaboration/state/{reference}/{site}', [StateController::class, 'destroy'])
                    ->name('collaboration.state.destroy')
                    ->where('reference', '.*');
            });
    }

    protected function registerBroadcastChannel()
    {
        Broadcast::channel('entry.{id}.{site}', function ($user, $id, $site) {
            $user = User::fromUser($user);

            return [
                'name' => $user->name(),
                'id' => $user->id(),
                'title' => $user->title(),
                'email' => $user->email(),
                'avatar' => $user->avatar(),
                'initials' => $user->initials(),
            ];
        }, ['guards' => [config('statamic.users.guards.cp')]]);
    }
}
