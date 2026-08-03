"use strict";

const EventEmitter = require("events");

class MarketEvents extends EventEmitter {

    constructor() {

        super();

        this.setMaxListeners(100);

    }

    emitConnect(data = {}) {

        this.emit("connect", data);

    }

    emitDisconnect(data = {}) {

        this.emit("disconnect", data);

    }

    emitReconnect(data = {}) {

        this.emit("reconnect", data);

    }

    emitTick(data) {

        this.emit("tick", data);

    }

    emitError(error) {

        this.emit("error", error);

    }

    onConnect(callback) {

        this.on("connect", callback);

    }

    onDisconnect(callback) {

        this.on("disconnect", callback);

    }

    onReconnect(callback) {

        this.on("reconnect", callback);

    }

    onTick(callback) {

        this.on("tick", callback);

    }

    onError(callback) {

        this.on("error", callback);

    }

}

module.exports = new MarketEvents();