'use strict';

class LiveCache {

    constructor() {

        this.cache = new Map();

    }

    set(key, value) {

        this.cache.set(key, {

            value,

            timestamp: Date.now()

        });

    }

    get(key) {

        const item = this.cache.get(key);

        return item ? item.value : null;

    }

    getWithTimestamp(key) {

        return this.cache.get(key) || null;

    }

    has(key) {

        return this.cache.has(key);

    }

    delete(key) {

        return this.cache.delete(key);

    }

    clear() {

        this.cache.clear();

    }

    size() {

        return this.cache.size;

    }

    keys() {

        return [...this.cache.keys()];

    }

    values() {

        return [...this.cache.values()].map(v => v.value);

    }

    entries() {

        return [...this.cache.entries()].map(

            ([k, v]) => [k, v.value]

        );

    }

    getAll() {

        const obj = {};

        for (const [key, value] of this.cache) {

            obj[key] = value.value;

        }

        return obj;

    }

}

module.exports = {

    LiveCache

};