/// <reference types="vite/client" />

// Compile-time constant injected by vite.config.ts `define`. True in dev
// builds, false in production so `if (__DEV__) console.log(...)` guards
// dead-code-eliminate cleanly in the prod bundle.
declare const __DEV__: boolean
