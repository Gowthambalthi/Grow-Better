"use strict";

const { EventEmitter } = require("events");

class ProtocolExplorer extends EventEmitter {

    constructor(manager) {

        super();

        this.manager = manager;
        this.nc = null;

        this.subjects = new Set();
        this.received = 0;
        this.bytes = 0;

    }

    async connect() {

        this.nc = await this.manager.connect();

        console.log("");
        console.log("======================================");
        console.log(" Groww Protocol Explorer");
        console.log("======================================");

        this.monitor();

    }

    async monitor() {

        (async () => {

            try {

                for await (const s of this.nc.status()) {

                    console.log(
                        "[STATUS]",
                        s.type,
                        s.data || ""
                    );

                }

            } catch (e) {

                console.error("[STATUS ERROR]", e);

            }

        })();

    }

    async subscribe(subject) {

        if (!this.nc) {
            throw new Error("Not connected.");
        }

        console.log("");
        console.log("[EXPLORER] SUB", subject);

        this.subjects.add(subject);

        let sub;

        try {

            sub = this.nc.subscribe(subject);

            // Ensure the SUB command is sent immediately
            await this.nc.flush();

            console.log("[EXPLORER] SUB ACK", subject);

        } catch (err) {

            console.error("[SUBSCRIBE FAILED]", err);

            throw err;

        }

        (async () => {

            try {

                for await (const msg of sub) {

                    this.received++;

                    this.bytes += msg.data.length;

                    console.log("");
                    console.log("================================");
                    console.log("MESSAGE", this.received);
                    console.log("Subject :", msg.subject);
                    console.log("Bytes   :", msg.data.length);
                    console.log("HEX");
                    console.log(
                        Buffer.from(msg.data).toString("hex")
                    );
                    console.log("================================");

                    this.emit("message", msg);

                }

            } catch (e) {

                console.error("[SUBSCRIBE ERROR]", e);

            }

        })();

        return sub;

    }

    async trySubjects(list) {

        for (const subject of list) {

            try {

                await this.subscribe(subject);

            } catch (err) {

                console.error(
                    "[FAILED]",
                    subject,
                    err.message
                );

            }

        }

    }

    stats() {

        console.log("");
        console.log("========== EXPLORER ==========");
        console.log("Subjects :", this.subjects.size);
        console.log("Messages :", this.received);
        console.log("Bytes    :", this.bytes);
        console.log("==============================");

    }

}

module.exports = {
    ProtocolExplorer
};