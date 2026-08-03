"use strict";

class SubscriptionCache {

    constructor() {

        this.cache = new Map();

    }

    add(token, subscription) {

        if (!token)
            throw new Error("Token is required.");

        this.cache.set(String(token), subscription);

        return subscription;

    }

    get(token) {

        return this.cache.get(String(token)) || null;

    }

    has(token) {

        return this.cache.has(String(token));

    }

    remove(token) {

        return this.cache.delete(String(token));

    }

    clear() {

        this.cache.clear();

    }

    size() {

        return this.cache.size;

    }

    getAll() {

        return Object.fromEntries(this.cache);

    }

}

module.exports = new SubscriptionCache();