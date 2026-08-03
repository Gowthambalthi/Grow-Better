"use strict";

const instrument =
require("../../broker/angelOne/instrument");

class SymbolMapper {

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

            this.map.set(

                String(item.token),

                item

            );

        }

        this.loaded = true;

    }

    async reload() {

        this.loaded = false;

        await this.load(true);

    }

    async getSymbol(token) {

        await this.load();

        const item =
            this.map.get(

                String(token)

            );

        if (!item)
            return null;

        return item.symbol;

    }

    async getInstrument(token) {

        await this.load();

        return this.map.get(

            String(token)

        ) || null;

    }

    async exists(token) {

        return (

            await this.getInstrument(token)

        ) !== null;

    }

    size() {

        return this.map.size;

    }

}

module.exports =
new SymbolMapper();