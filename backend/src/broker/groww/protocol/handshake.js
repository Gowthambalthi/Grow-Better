'use strict';

const { EventEmitter } = require('events');

class Handshake extends EventEmitter {

    constructor(nc) {

        super();

        this.nc = nc;

        this.started = false;
        this.completed = false;

        this.steps = [];

    }

    async start() {

        if (this.started)
            return;

        this.started = true;

        console.log("");
        console.log("==================================");
        console.log(" Groww Handshake Monitor");
        console.log("==================================");

        try {

            for await (const status of this.nc.status()) {

                const event = {

                    time: new Date(),

                    type: status.type,

                    data: status.data

                };

                this.steps.push(event);

                console.log(
                    "[HANDSHAKE]",
                    event.type,
                    event.data || ""
                );

                this.emit(
                    "status",
                    event
                );

            }

        }
        catch (err) {

            console.error(
                "[HANDSHAKE ERROR]"
            );

            console.error(err);

        }

    }

    packet(msg) {

        console.log("");

        console.log("[HANDSHAKE PACKET]");

        console.log("Subject :", msg.subject);

        console.log(
            "Bytes   :",
            msg.data.length
        );

        this.emit(
            "packet",
            msg
        );

    }

    finish() {

        this.completed = true;

        console.log("");

        console.log(
            "Handshake Complete"
        );

        console.log(
            "Events :",
            this.steps.length
        );

    }

    summary() {

        console.log("");

        console.log("========== HANDSHAKE ==========");

        console.log(
            "Started   :",
            this.started
        );

        console.log(
            "Completed :",
            this.completed
        );

        console.log(
            "Events    :",
            this.steps.length
        );

        console.log("===============================");

        for (const step of this.steps) {

            console.log(

                step.time.toISOString(),

                step.type,

                step.data || ""

            );

        }

    }

}

module.exports = {

    Handshake

};