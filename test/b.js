"use strict";

const AngelBroker =
require("../backend/src/broker/angelOne/broker");

const WSClient =
require("../backend/src/broker/angelOne/websocket/client");

const Packet =
require("../backend/src/broker/angelOne/websocket/packet");

(async () => {

    console.log("====================================");
    console.log(" CUSTOM PARSER TEST");
    console.log("====================================");

    const broker =
        new AngelBroker();

    console.log("\n1. LOGIN");

    await broker.login();

    console.log("SUCCESS");

    const client =
        new WSClient(

            "wss://smartapisocket.angelone.in/smart-stream",

            {

                Authorization:
                    broker.session.data.jwtToken,

                "x-api-key":
                    broker.websocket.credentials.apiKey,

                "x-client-code":
                    broker.websocket.credentials.clientCode,

                "x-feed-token":
                    broker.session.data.feedToken

            }

        );

    client.on("connect", () => {

        console.log("\nCONNECTED");

        const request =

            Packet.subscribe(

                "NSE:SBIN",

                3,

                2,

                [

                    "3045"

                ]

            );

        console.log("\nSUBSCRIBE REQUEST");

        console.dir(

            request,

            {

                depth: null

            }

        );

        client.subscribe(request);

    });

    client.on("tick", tick => {

        console.log("");

        console.log("====================================");
        console.log(" PARSED TICK");
        console.log("====================================");

        console.dir(

            tick,

            {

                depth: null

            }

        );

        console.log("");

        console.log("-----------------------------");

        console.log(

            "TOKEN  :",

            tick.token

        );

        console.log(

            "MODE   :",

            tick.subscription_mode

        );

        console.log(

            "LTP    :",

            Number(tick.last_traded_price) / 100

        );

        if (tick.open_price_day !== undefined) {

            console.log(

                "OPEN   :",

                Number(tick.open_price_day) / 100

            );

            console.log(

                "HIGH   :",

                Number(tick.high_price_day) / 100

            );

            console.log(

                "LOW    :",

                Number(tick.low_price_day) / 100

            );

            console.log(

                "CLOSE  :",

                Number(tick.close_price) / 100

            );

            console.log(

                "VOLUME :",

                tick.vol_traded

            );

        }

        console.log("-----------------------------");

    });

    client.on("disconnect", () => {

        console.log("\nDISCONNECTED");

    });

    client.on("error", error => {

        console.error("\nERROR");

        console.error(error);

    });

    await client.connect();

})();