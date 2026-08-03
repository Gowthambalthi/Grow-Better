'use strict';

const { EventEmitter } = require('events');

class ProtocolMonitor extends EventEmitter {

    constructor() {

        super();

        this.connectedAt = null;

        this.messages = 0;

        this.bytes = 0;

        this.subscriptions = new Set();

        this.lastMessage = null;

        this.statusEvents = [];

    }

    connectionOpened() {

        this.connectedAt = Date.now();

        console.log("========================================");
        console.log("Groww Protocol Monitor");
        console.log("========================================");
        console.log("Connected At :", new Date().toLocaleString());

    }

    connectionClosed(err) {

        console.log("----------------------------------------");
        console.log("Connection Closed");

        if (err)
            console.error(err);

    }

    status(status) {

        this.statusEvents.push({

            time: Date.now(),

            type: status.type,

            data: status.data

        });

        console.log(
            "[STATUS]",
            status.type,
            status.data || ""
        );

    }

    subscribed(subject) {

        this.subscriptions.add(subject);

        console.log("[SUBSCRIBE]", subject);

    }

    unsubscribed(subject) {

        this.subscriptions.delete(subject);

        console.log("[UNSUBSCRIBE]", subject);

    }

    packet(msg) {

        this.messages++;

        this.bytes += msg.data.length;

        this.lastMessage = Date.now();

        console.log("----------------------------------------");
        console.log("PACKET #" + this.messages);
        console.log("Subject :", msg.subject);
        console.log("Bytes   :", msg.data.length);

    }

    error(err) {

        console.error("[PROTOCOL ERROR]");

        console.error(err);

    }

    summary() {

        console.log("");
        console.log("========== SUMMARY ==========");

        console.log(
            "Connected :",
            this.connectedAt
                ? "YES"
                : "NO"
        );

        console.log(
            "Subscriptions :",
            this.subscriptions.size
        );

        console.log(
            "Packets :",
            this.messages
        );

        console.log(
            "Bytes :",
            this.bytes
        );

        console.log(
            "Last Packet :",
            this.lastMessage
                ? new Date(this.lastMessage)
                : "Never"
        );

        console.log("=============================");

    }

}

module.exports = {

    ProtocolMonitor

};