"use strict";

const { Parser } = require("binary-parser");

const MODE = {
    LTP: 1,
    Quote: 2,
    SnapQuote: 3,
    Depth: 4
};

function toNumber(number) {
    return number.toString();
}

function _atos(array) {

    const chars = [];

    for (let i = 0; i < array.length; i++) {

        chars.push(

            String.fromCharCode(array[i])

        );

    }

    return chars

        .join("")

        .replace(/\0/g, "");

}

function LTP(buf) {

    return new Parser()

        .endianness("little")

        .int8("subscription_mode", { formatter: toNumber })

        .int8("exchange_type", { formatter: toNumber })

        .array("token", {

            type: "uint8",

            length: 25,

            formatter: _atos

        })

        .int64("sequence_number", { formatter: toNumber })

        .int64("exchange_timestamp", { formatter: toNumber })

        .int32("last_traded_price", { formatter: toNumber })

        .parse(buf);

}

function QUOTE(buf) {

    return new Parser()

        .endianness("little")

        .uint8("subscription_mode", { formatter: toNumber })

        .uint8("exchange_type", { formatter: toNumber })

        .array("token", {

            type: "int8",

            length: 25,

            formatter: _atos

        })

        .uint64("sequence_number", { formatter: toNumber })

        .uint64("exchange_timestamp", { formatter: toNumber })

        .uint64("last_traded_price", { formatter: toNumber })

        .int64("last_traded_quantity", { formatter: toNumber })

        .int64("avg_traded_price", { formatter: toNumber })

        .int64("vol_traded", { formatter: toNumber })

        .doublele("total_buy_quantity")

        .doublele("total_sell_quantity")

        .int64("open_price_day", { formatter: toNumber })

        .int64("high_price_day", { formatter: toNumber })

        .int64("low_price_day", { formatter: toNumber })

        .int64("close_price", { formatter: toNumber })

        .parse(buf);

}

function SNAP_QUOTE(buf) {

    const bestFive = new Parser()

        .endianness("little")

        .int16("flag", { formatter: toNumber })

        .int64("quantity", { formatter: toNumber })

        .int64("price", { formatter: toNumber })

        .int16("no_of_orders", { formatter: toNumber });

    return new Parser()

        .endianness("little")

        .uint8("subscription_mode", { formatter: toNumber })

        .uint8("exchange_type", { formatter: toNumber })

        .array("token", {

            type: "int8",

            length: 25,

            formatter: _atos

        })

        .uint64("sequence_number", { formatter: toNumber })

        .uint64("exchange_timestamp", { formatter: toNumber })

        .uint64("last_traded_price", { formatter: toNumber })

        .int64("last_traded_quantity", { formatter: toNumber })

        .int64("avg_traded_price", { formatter: toNumber })

        .int64("vol_traded", { formatter: toNumber })

        .doublele("total_buy_quantity")

        .doublele("total_sell_quantity")

        .int64("open_price_day", { formatter: toNumber })

        .int64("high_price_day", { formatter: toNumber })

        .int64("low_price_day", { formatter: toNumber })

        .int64("close_price", { formatter: toNumber })

        .int64("last_traded_timestamp", { formatter: toNumber })

        .int64("open_interest", { formatter: toNumber })

        .doublele("open_interest_change")

        .array("best_5_buy_data", {

            type: bestFive,

            lengthInBytes: 100

        })

        .array("best_5_sell_data", {

            type: bestFive,

            lengthInBytes: 100

        })

        .int64("upper_circuit", { formatter: toNumber })

        .int64("lower_circuit", { formatter: toNumber })

        .int64("fiftytwo_week_high", { formatter: toNumber })

        .int64("fiftytwo_week_low", { formatter: toNumber })

        .parse(buf);

}

function DEPTH(buf) {

    const depthTwenty = new Parser()

        .endianness("little")

        .int32("quantity", { formatter: toNumber })

        .int32("price", { formatter: toNumber })

        .int16("no_of_orders", { formatter: toNumber });

    return new Parser()

        .endianness("little")

        .uint8("subscription_mode", { formatter: toNumber })

        .uint8("exchange_type", { formatter: toNumber })

        .array("token", {

            type: "int8",

            length: 25,

            formatter: _atos

        })

        .uint64("exchange_timestamp", { formatter: toNumber })

        .int64("packet_received_time", { formatter: toNumber })

        .array("depth_twenty_buy_data", {

            type: depthTwenty,

            lengthInBytes: 200

        })

        .array("depth_twenty_sell_data", {

            type: depthTwenty,

            lengthInBytes: 200

        })

        .parse(buf);

}

function parse(buffer) {

    const mode =

        new Parser()

            .uint8("subscription_mode")

            .parse(buffer)

            .subscription_mode;

    switch (mode) {

        case MODE.LTP:

            return LTP(buffer);

        case MODE.Quote:

            return QUOTE(buffer);

        case MODE.SnapQuote:

            return SNAP_QUOTE(buffer);

        case MODE.Depth:

            return DEPTH(buffer);

        default:

            return buffer;

    }

}

module.exports = {

    parse

};