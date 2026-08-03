'use strict';

const path = require('path');
const protobuf = require('protobufjs');

console.log("Loading Groww Protobuf Schemas...");

const marketRoot = protobuf.loadSync(
    path.join(__dirname, 'proto', 'market.proto')
);

const orderRoot = protobuf.loadSync(
    path.join(__dirname, 'proto', 'order.proto')
);

const positionRoot = protobuf.loadSync(
    path.join(__dirname, 'proto', 'position.proto')
);

const MarketTick =
    marketRoot.lookupType('MarketTick');

const OrderBroadcast =
    orderRoot.lookupType('OrderBroadcast');

const PositionDetail =
    positionRoot.lookupType('PositionDetail');

const OPTIONS = {

    longs: Number,

    enums: String,

    defaults: true,

    arrays: true,

    objects: true

};

function decode(type, bytes) {

    if (!bytes || bytes.length === 0) {

        throw new Error(
            "Empty protobuf message."
        );

    }

    return type.toObject(

        type.decode(bytes),

        OPTIONS

    );

}

function decodeMarketTick(bytes) {

    return decode(

        MarketTick,

        bytes

    );

}

function decodeOrderUpdate(bytes) {

    const obj = decode(

        OrderBroadcast,

        bytes

    );

    return obj.orderDetail || obj;

}

function decodePositionUpdate(bytes) {

    const obj = decode(

        PositionDetail,

        bytes

    );

    return obj.positionInfo || obj;

}

module.exports = {

    decodeMarketTick,

    decodeOrderUpdate,

    decodePositionUpdate

};