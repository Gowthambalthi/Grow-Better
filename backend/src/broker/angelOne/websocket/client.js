"use strict";

const EventEmitter = require("events");
const WebSocket = require("ws");
const parser = require("./parser");

class WSClient extends EventEmitter {

    constructor(url, headers = {}) {

        super();

        this.url = url;
        this.headers = headers;
        this.ws = null;
        this.connected = false;

    }

    connect() {

        return new Promise((resolve, reject) => {

            this.ws = new WebSocket(

                this.url,

                {

                    headers: this.headers

                }

            );

            this.ws.on("open", () => {

                this.connected = true;

                this.emit("connect");

                resolve();

            });

            this.ws.on("message", data => {

                try {

                    const buffer = Buffer.from(data);

                    const tick = parser.parse(

                        buffer,

                        data

                    );

                    this.emit(

                        "tick",

                        tick

                    );

                }

                catch (error) {

                    this.emit(

                        "error",

                        error

                    );

                }

            });

            this.ws.on("error", error => {

                this.emit(

                    "error",

                    error

                );

                reject(error);

            });

            this.ws.on("close", () => {

                this.connected = false;

                this.emit(

                    "disconnect"

                );

            });

        });

    }

    send(data) {

        if (!this.connected)
            return;

        console.log("");
        console.log("SEND");

        console.dir(

            data,

            {

                depth: null

            }

        );

        this.ws.send(

            JSON.stringify(data)

        );

    }

    subscribe(request) {

        this.send(request);

    }

    unsubscribe(request) {

        this.send(request);

    }

    close() {

        if (this.ws) {

            this.ws.close();

        }

    }

    isConnected() {

        return this.connected;

    }

}

module.exports = WSClient;