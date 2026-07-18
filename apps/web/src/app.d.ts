declare global {
    namespace App {
        interface Locals {
            user: import('@remote-reader/shared').User | null;
        }
    }
}

export {};
