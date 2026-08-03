from growwapi.groww.client import GrowwAPI
from growwapi.groww.feed import GrowwFeed
import time
# -------------------------
# CHANGE THESE
# -------------------------
TOKEN = "eyJraWQiOiJaTUtjVXciLCJhbGciOiJFUzI1NiJ9.eyJleHAiOjI1NzM2NDEyNjQsImlhdCI6MTc4NTI0MTI2NCwibmJmIjoxNzg1MjQxMjY0LCJzdWIiOiJ7XCJ0b2tlblJlZklkXCI6XCJlZmRjZjUzOS1jYjc3LTQ0ODgtOTVhMS0zMzlmMzE0ZDZkZGNcIixcInZlbmRvckludGVncmF0aW9uS2V5XCI6XCJlMzFmZjIzYjA4NmI0MDZjODg3NGIyZjZkODQ5NTMxM1wiLFwidXNlckFjY291bnRJZFwiOlwiODUxYzQ4YjAtZGJkNS00M2VjLTlhNzItZTliNjRiY2VkMTNiXCIsXCJkZXZpY2VJZFwiOlwiOTViNmYxM2MtYWQ0MC01ZWRmLWE0MmYtMWIyNDc2NTRmY2Q3XCIsXCJzZXNzaW9uSWRcIjpcIjk5OTRiYWI5LTAxMmEtNGU2Ni04YzQyLTNiNjE3ZDM1ODg4YlwiLFwiYWRkaXRpb25hbERhdGFcIjpcIno1NC9NZzltdjE2WXdmb0gvS0EwYkNBK0E5eStpdDBRb2ZkSmdmN1NmMXhSTkczdTlLa2pWZDNoWjU1ZStNZERhWXBOVi9UOUxIRmtQejFFQisybTdRPT1cIixcInJvbGVcIjpcImF1dGgtdG90cFwiLFwic291cmNlSXBBZGRyZXNzXCI6XCI0OS4yMzguMzIuOTcsMTA0LjIyLjYuMTMyLDM1LjI0MS4yMy4xMjNcIixcInR3b0ZhRXhwaXJ5VHNcIjoyNTczNjQxMjY0MTI0LFwidmVuZG9yTmFtZVwiOlwiZ3Jvd3dBcGlcIn0iLCJpc3MiOiJhcGV4LWF1dGgtcHJvZC1hcHAifQ.sa46SqvnEnNIDStX4VJ5i9d7Y4hpeFp6ojkSsiPj9i5TwAexFW5pe7rIwCeB6HZw6xht5SciBl66VDB2NXGnAA"

client = GrowwAPI(TOKEN)

print("Login OK")

feed = GrowwFeed(client)

feed.subscribe_ltp([
    {
        "exchange": "NSE",
        "segment": "CASH",
        "exchange_token": "2885"
    }
])

print("Subscribed")

# Starts the NATS consumer thread
feed.consume()

print("Waiting for data...")

while True:
    try:
        data = feed.get_ltp()
        print(data)
    except Exception as e:
        print("Error:", e)

    time.sleep(1)