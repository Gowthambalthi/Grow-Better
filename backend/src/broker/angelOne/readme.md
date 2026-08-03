# Angel One Broker SDK

A production-ready Node.js SDK for integrating with the Angel One SmartAPI. This SDK provides authentication, REST APIs, live market data through WebSocket, instrument management, and a unified broker interface for building trading applications, scanners, portfolio trackers, and automated trading systems.

---

# Features

- Secure Login using TOTP Authentication
- Automatic Session Management
- Instrument Master Download & Caching
- Symbol to Token Resolution
- Live Market Data via WebSocket
- Real-Time Market Cache
- Profile API
- Funds API
- Holdings API
- Positions API
- Orders API
- Trades API
- Quote (LTP) API
- Unified Broker Interface
- Automatic Reconnection Support
- Common REST API Layer

---

# Project Structure

```text
backend/
└── src/
    └── angelOne/
        │
        ├── api.js
        ├── broker.js
        ├── constants.js
        ├── login.js
        ├── instrument.js
        ├── search.js
        ├── websocket.js
        ├── market.js
        │
        ├── profile.js
        ├── funds.js
        ├── holdings.js
        ├── positions.js
        ├── orders.js
        ├── trades.js
        ├── quotes.js
        │
        └── cache/
            └── instruments.json
```

---

# Module Overview

## api.js

Central HTTP client used by all REST services.

### Responsibilities

- Create Axios client
- Configure default headers
- GET requests
- POST requests
- PUT requests
- DELETE requests
- Error handling

---

## login.js

Handles Angel One authentication.

### Features

- Generate TOTP
- Login
- Session Caching
- JWT Token Management
- Feed Token Management
- Logout

### Returns

- JWT Token
- Feed Token
- Refresh Token

---

## instrument.js

Downloads and caches Angel One Instrument Master.

### Features

- Download Instrument Master
- Local Cache
- Search Instruments
- Symbol Lookup
- Token Lookup

### Methods

```javascript
load()
reload()
all()
find()
token()
exists()
byToken()
search()
```

---

## search.js

Resolves trading symbols into instrument information.

### Example

```javascript
await search("NSE", "SBIN")
```

Returns

```javascript
{
    exchange,
    tradingSymbol,
    symbolToken,
    instrument
}
```

---

## constants.js

Contains SDK constants.

### Subscription Modes

- LTP
- Quote
- Snap Quote
- Depth

### Actions

- Subscribe
- Unsubscribe

### Exchanges

- NSE
- BSE
- NFO
- MCX
- NCDEX
- CDE

---

## websocket.js

Manages the SmartAPI WebSocket connection.

### Features

- Connect
- Disconnect
- Reconnect
- Subscribe
- Unsubscribe
- Subscribe Multiple Symbols
- Resubscribe
- Heartbeat Handling
- Tick Events

### Methods

```javascript
connect()

disconnect()

reconnect()

subscribe()

unsubscribe()

subscribeMany()

unsubscribeAll()

resubscribe()

getSubscriptions()

isConnected()
```

---

## market.js

Maintains a live in-memory cache of market data.

### Features

- Live Tick Cache
- Instant Price Lookup
- Best Bid
- Best Ask
- OHLC
- Volume

### Methods

```javascript
get()

getAll()

getLTP()

getOpen()

getHigh()

getLow()

getClose()

getVolume()

getBestBid()

getBestAsk()

remove()

clear()
```

---

## profile.js

Returns user profile information.

### Includes

- Name
- Email
- Client Code
- PAN Details

---

## funds.js

Returns account fund information.

### Includes

- Available Balance
- Cash
- Margin
- Collateral
- Utilized Funds

---

## holdings.js

Returns delivery holdings.

### Includes

- Trading Symbol
- Quantity
- Average Price
- Current Value

---

## positions.js

Returns open positions.

### Includes

- Intraday Positions
- MTF Positions
- F&O Positions
- Realized P&L
- Unrealized P&L

---

## orders.js

Returns order book.

### Features

- Order Book
- Get Order By ID

---

## trades.js

Returns executed trades.

### Includes

- Trade History
- Executed Orders

---

## quotes.js

Returns current LTP using REST API.

### Returns

- LTP
- Open
- High
- Low
- Close

---

## broker.js

The main SDK entry point.

Applications only interact with this class.

### Available Methods

```javascript
login()

logout()

connect()

disconnect()

subscribe()

unsubscribe()

getProfile()

getFunds()

getHoldings()

getPositions()

getOrders()

getOrder()

getTrades()

getQuote()
```

---

# Architecture

```text
                    AngelBroker
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     Login           REST APIs        WebSocket
        │                │                │
        │                │                │
   JWT Token        Account Data     Live Ticks
 Feed Token             │                │
        └────────────────┼────────────────┘
                         │
                    Market Cache
                         │
                    Trading System
```

---

# Usage

## Login

```javascript
const AngelBroker = require("./broker");

const broker = new AngelBroker();

await broker.login();
```

---

## Connect WebSocket

```javascript
await broker.connect();
```

---

## Subscribe

```javascript
await broker.subscribe(
    "NSE",
    "SBIN"
);
```

---

## Listen for Live Data

```javascript
broker.websocket.on(
    "tick",
    tick => {

        if (tick === "pong")
            return;

        console.log(
            Number(
                tick.last_traded_price
            ) / 100
        );

    }
);
```

---

## Get Holdings

```javascript
const holdings =
await broker.getHoldings();
```

---

## Get Positions

```javascript
const positions =
await broker.getPositions();
```

---

## Get Orders

```javascript
const orders =
await broker.getOrders();
```

---

## Get Trades

```javascript
const trades =
await broker.getTrades();
```

---

## Get Funds

```javascript
const funds =
await broker.getFunds();
```

---

## Get Quote

```javascript
const quote =
await broker.getQuote(
    "NSE",
    "SBIN",
    "3045"
);
```

---

# Current Status

## Completed

- Authentication
- Session Management
- Instrument Master
- Local Instrument Cache
- Symbol Search
- REST APIs
- Live WebSocket
- Live Market Cache
- Broker Interface

---

# Planned Features

- Place Order
- Modify Order
- Cancel Order
- GTT Orders
- Portfolio Engine
- Live MTM
- Live Portfolio P&L
- Watchlist Manager
- Scanner Engine
- News Engine
- Alert Engine
- Groww Broker Integration
- Multi Broker Support

---

# License

MIT License

---

# Author

Developed by **Gowtham Balthi**.