'use strict';

const fs = require('fs');
const path = require('path');

class PacketLogger {

    constructor(logDir = path.join(process.cwd(), "logs")) {

        this.logDir = logDir;

        this.packetFile = path.join(
            this.logDir,
            "groww_packets.log"
        );

        this.jsonFile = path.join(
            this.logDir,
            "groww_packets.json"
        );

        this.enabled = true;

        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

    }

    enable() {
        this.enabled = true;
    }

    disable() {
        this.enabled = false;
    }

    clear() {

        try {

            fs.writeFileSync(this.packetFile, "");

            fs.writeFileSync(this.jsonFile, "[]");

        }
        catch (e) {}

    }

    log(msg) {

        if (!this.enabled)
            return;

        const packet = {

            time: new Date().toISOString(),

            subject: msg.subject,

            size: msg.data.length,

            hex: Buffer.from(msg.data).toString("hex"),

            base64: Buffer.from(msg.data).toString("base64")

        };

        fs.appendFileSync(

            this.packetFile,

            JSON.stringify(packet) + "\n"

        );

        let list = [];

        try {

            list = JSON.parse(

                fs.readFileSync(

                    this.jsonFile,

                    "utf8"

                )

            );

        }
        catch (e) {}

        list.push(packet);

        fs.writeFileSync(

            this.jsonFile,

            JSON.stringify(

                list,

                null,

                2

            )

        );

        console.log(
            "[LOGGER]",
            packet.subject,
            packet.size,
            "bytes"
        );

    }

}

module.exports = {

    PacketLogger

};