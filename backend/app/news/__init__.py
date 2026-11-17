# News pulled from Alpaca's headline feed and served back per watched symbol.
#
# Two halves, split the way the rest of the app is: alpaca.py speaks HTTP and
# knows nothing about storage, while the news tables live in
# app/turso/userdata.py with every other Turso read and write.
#
# backend/scripts/news_daily.py is the only caller that runs on a schedule; the
# API routes read the stored snapshot and never touch Alpaca themselves.
