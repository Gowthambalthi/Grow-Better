"use strict";

const {
    ACTION
} = require("./constants");

class Packet {

    static subscribe(

        correlationID,
        mode,
        exchangeType,
        tokens

    ) {

        return {

            correlationID,

            action: ACTION.SUBSCRIBE,

            params: {

                mode,

                tokenList: [

                    {

                        exchangeType,

                        tokens

                    }

                ]

            }

        };

    }

    static unsubscribe(

        correlationID,
        mode,
        exchangeType,
        tokens

    ) {

        return {

            correlationID,

            action: ACTION.UNSUBSCRIBE,

            params: {

                mode,

                tokenList: [

                    {

                        exchangeType,

                        tokens

                    }

                ]

            }

        };

    }

}

module.exports = Packet;