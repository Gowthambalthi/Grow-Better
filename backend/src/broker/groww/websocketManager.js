'use strict';

const { EventEmitter } = require('events');
const { connect, jwtAuthenticator } = require('nats.ws');
const { createSocketCredentials } = require('./authSocket');

const SOCKET_URL = 'wss://socket-api.groww.in';

class WebsocketManager extends EventEmitter {

    constructor() {
        super();

        this.nc = null;
        this.subscriptionId = null;
        this.subscriptions = new Map();
        this.connected = false;
    }

    async connect() {

        if (this.nc) {
            return this.nc;
        }

        console.log("======================================");
        console.log("Groww Live Feed");
        console.log("======================================");

        console.log("Getting socket credentials...");

        const creds = await createSocketCredentials();

        this.subscriptionId = creds.subscriptionId;

        console.log("Subscription ID :", this.subscriptionId);

        console.log("Connecting to Groww NATS...");

        this.nc = await connect({
            servers: SOCKET_URL,
            authenticator: jwtAuthenticator(
                creds.token,
                creds.seed
            ),
            maxReconnectAttempts: 10
        });

        this.connected = true;

        console.log("Connected.");

        this.emit("connect");

        this.monitorStatus();
        this.monitorClose();

        return this.nc;
    }

    async monitorStatus() {

        try {

            for await (const status of this.nc.status()) {

                console.log("[STATUS]", status.type, status.data || "");

            }

        }
        catch (err) {

            console.error("[STATUS ERROR]", err.message);

        }

    }

    async monitorClose() {

        try {

            const err = await this.nc.closed();

            this.connected = false;

            this.nc = null;

            this.subscriptions.clear();

            console.log("Socket closed.");

            if (err) {
                console.error(err);
            }

            this.emit("disconnect", err);

        }
        catch (err) {

            console.error(err);

        }

    }

    async disconnect() {

        if (!this.nc) {
            return;
        }

        console.log("Disconnecting...");

        await this.nc.close();

        this.connected = false;

        this.nc = null;

        this.subscriptions.clear();

        this.emit("disconnect");
    }

    getConnection() {

        return this.nc;

    }

    getSubscriptionId() {

        return this.subscriptionId;

    }

    isConnected() {

        return this.connected;

    }

    async subscribe(subject, callback) {

        if (!this.nc) {
            throw new Error("Not connected.");
        }

        console.log("--------------------------------------");
        console.log("SUBSCRIBE");
        console.log(subject);
        console.log("--------------------------------------");

        const sub = this.nc.subscribe(subject);

        this.subscriptions.set(subject, sub);

        // Official growwapi (Python) nats_client.py does this after every
        // subscribe: await self._socket.flush(10). Without it, the SUB frame
        // can sit unflushed and the server may not register interest before
        // the first tick would have been published — connect succeeds,
        // subscribe "succeeds" locally, and nothing ever arrives.
        await this.nc.flush();

        (async () => {

            try {

                for await (const msg of sub) {

                    console.log("[RAW]");
                    console.log("Subject :", msg.subject);
                    console.log("Bytes   :", msg.data.length);

                    callback(msg);

                }

            }
            catch (err) {

                console.error("[SUBSCRIBE ERROR]", err);

            }

        })();

        return sub;
    }

    unsubscribe(subject) {

        const sub = this.subscriptions.get(subject);

        if (!sub) {
            return;
        }

        sub.unsubscribe();

        this.subscriptions.delete(subject);

        console.log("Unsubscribed :", subject);

    }

    unsubscribeAll() {

        for (const sub of this.subscriptions.values()) {

            sub.unsubscribe();

        }

        this.subscriptions.clear();

        console.log("All subscriptions removed.");

    }

}

module.exports = {
    WebsocketManager
};