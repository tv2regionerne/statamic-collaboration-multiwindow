<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Sound Effects
    |--------------------------------------------------------------------------
    |
    | This determines whether or not the open sound effects are played when a
    | user joins or leaves a room.
    |
    */

    'sound_effects' => true,

    /*
    |--------------------------------------------------------------------------
    | Debug Mode
    |--------------------------------------------------------------------------
    |
    | When enabled, detailed debug messages will be logged to the browser
    | console. Useful for troubleshooting collaboration issues.
    |
    */

    'debug' => env('COLLABORATION_DEBUG', false),

];
