"use strict";

const instrument =
require("../../broker/angelOne/instrument");

class TokenMapper {

    constructor() {

        this.map = new Map();

        this.loaded = false;

    }

    async load(force = false) {

        if (this.loaded && !force)
            return;

        this.map.clear();

        const data =
            await instrument.all();

        for (const item of data) {

            if (!item.symbol)
                continue;

            this.map.set(

                item.symbol.toUpperCase(),

                item.token

            );

            if (item.name) {

                this.map.set(

                    item.name.toUpperCase(),

                    item.token

                );

            }

        }

        this.loaded = true;

    }

    async reload() {

        this.loaded = false;

        await this.load(true);

    }

    async getToken(symbol) {

        await this.load();

        return this.map.get(

            symbol.toUpperCase()

        ) || null;

    }

    async exists(symbol) {

        return (

            await this.getToken(symbol)

        ) !== null;

    }

    size() {

        return this.map.size;

    }

}

module.exports =
new TokenMapper();