# Return specific errors when a coupon can't be redeemed

Support keeps asking why a coupon "didn't work". This splits the single UPDATE into a lookup plus explicit checks, so the API can say whether the code is unknown, expired, or used up. Still runs in one transaction.
