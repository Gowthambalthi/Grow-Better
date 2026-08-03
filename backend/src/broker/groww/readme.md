# Groww Node.js SDK

A production-ready Node.js SDK for the Groww Trade API.

This SDK provides authentication, account management, order management, portfolio APIs, instrument search, and an experimental WebSocket implementation.

---

# Features

## Authentication

- TOTP Login
- JWT Access Token Management
- Automatic Session Handling

---

## Account APIs

- Profile
- Funds / Margin
- Holdings
- Positions
- Orders
- Trades (if enabled)

---

## Order APIs

- Place Order
- Modify Order
- Cancel Order
- Order Book

---

## Instrument APIs

- Download Instrument Master
- Instrument Search
- Search by Symbol
- Search by Exchange Token
- Search by Segment
- Search by Instrument Type

---

## WebSocket (Experimental)

Implemented

- Socket Authentication
- NATS Authentication
- JWT + NKey Authentication
- Subject Builder
- Protobuf Decoder
- LTP Subscription
- Market Depth Subscription
- Order Update Subscription
- Position Update Subscription

Current Status

- Successfully Authenticates
- Successfully Connects to Groww NATS
- Successfully Subscribes to Topics
- No Live Tick Data Received

Reason

The SDK successfully establishes the websocket connection, but Groww does not publish live market data for the current API account. This is likely due to market-data entitlement or account permissions.

---

# Folder Structure

```
groww/
│
├── auth/
├── config/
├── instruments/
├── market/
├── orders/
├── portfolio/
├── websocket/
├── proto/
├── decoder/
└── test/
```

---

# APIs Implemented

## Authentication

- Login

---

## Profile

- Get Profile

---

## Funds

- Get Funds

---

## Holdings

- Get Holdings

---

## Positions

- Get Positions

---

## Orders

- Get Orders
- Place Order
- Modify Order
- Cancel Order

---

## Instruments

- Download Instrument Master
- Search Instruments
- Get Instrument by Symbol
- Get Instrument by Token

---

## WebSocket

- Connect
- Disconnect
- Subscribe LTP
- Subscribe Market Depth
- Subscribe Order Updates
- Subscribe Position Updates

---

# Testing

Completed

- Login
- Profile
- Funds
- Holdings
- Positions
- Orders
- Instrument Search
- Instrument Master
- Socket Authentication
- WebSocket Connection
- Subject Subscription

---

# Known Limitations

## Quote API

```
HTTP 403
Access forbidden for this request.
```

The Quote REST API is currently not accessible using the available Groww API permissions.

---

## Live WebSocket

Current behaviour

```
Login ✓
Socket Token ✓
Connected ✓
Subscribed ✓
Waiting for Market Data...
```

The websocket implementation successfully authenticates and subscribes but does not receive live market ticks.

Possible reasons include:

- Live market-data entitlement not enabled
- Broker account restrictions
- Additional undocumented Groww websocket requirements

---

# Recommended Architecture

For production usage:

## Groww

- Login
- Profile
- Funds
- Holdings
- Positions
- Orders
- Place / Modify / Cancel Orders
- Instrument Master

## Angel One

- Live LTP
- Market Depth
- WebSocket Streaming
- Portfolio Live Prices
- Scanner Data

This hybrid architecture combines Groww's trading capabilities with Angel One's reliable live market data feed.

---

# Project Status

| Module | Status |
|---------|--------|
| Authentication | ✅ Complete |
| Profile | ✅ Complete |
| Funds | ✅ Complete |
| Holdings | ✅ Complete |
| Positions | ✅ Complete |
| Orders | ✅ Complete |
| Instruments | ✅ Complete |
| WebSocket Authentication | ✅ Complete |
| WebSocket Connection | ✅ Complete |
| Protobuf Decoder | ✅ Complete |
| Quote API | ⚠️ Permission Restricted |
| Live Market Data | ⚠️ Awaiting Live Feed / Entitlement |

---

# License

MIT License
