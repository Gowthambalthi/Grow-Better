"use strict";

const EventEmitter = require("events");

class Market {

    constructor() {

        this.events = new EventEmitter();

        this.started = false;

    }

    async start() {

        console.log("Starting Market Engine...");

        this.started = true;

        this.events.emit("connect");

        return true;

    }

    async stop() {

        console.log("Stopping Market Engine...");

        this.started = false;

        this.events.emit("disconnect");

        return true;

    }

    isRunning() {

        return this.started;

    }

    subscribeStock(symbol) {

        console.log("Subscribe Stock:", symbol);

    }

    unsubscribeStock(symbol) {

        console.log("Unsubscribe Stock:", symbol);

    }

    subscribeIndices() {

        console.log("Subscribe Default Indices");

    }

    subscribeCommodities() {

        console.log("Subscribe Default Commodities");

    }

    get(symbol) {

        console.log("Get:", symbol);

        return null;

    }

    getAll() {

        return {};

    }

    getSubscriptions() {

        return [];

    }

    on(event, callback) {

        this.events.on(event, callback);

    }

}

module.exports = new Market();