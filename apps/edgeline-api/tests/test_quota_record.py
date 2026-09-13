"""`record_quota` — the credit meter actually moving (§8, §10).

Written because the meter read `0 / 500` on a live install that had spent twelve
credits. Nothing had ever written `quota_used`, so the field stayed null from
bootstrap and the dashboard rendered null as zero. On a 500-credit allowance with
a guard that refuses requests near the ceiling, a meter stuck at zero is worse
than no meter: it reads as headroom.

The pace guard was never affected — it compares `x-requests-used` in memory on
the adapter. These tests are about the readout.
"""

from __future__ import annotations

from edgeline.indices import PROVIDERS_INDEX, with_prefix
from edgeline.providers.base import QuotaStatus
from edgeline.scheduler import record_quota

PREFIX = "edgeline-test-"


class FakeClient:
    def __init__(self, fail: bool = False) -> None:
        self.updates: list[dict] = []
        self.fail = fail

    async def update(self, *, index, id, doc, refresh=False):  # noqa: A002
        if self.fail:
            raise RuntimeError("cluster is having a day")
        self.updates.append({"index": index, "id": id, "doc": doc})


async def test_it_writes_what_the_headers_reported():
    client = FakeClient()
    await record_quota(client, "the_odds_api", QuotaStatus(used=12, remaining=488), prefix=PREFIX)

    assert client.updates == [
        {
            "index": with_prefix(PROVIDERS_INDEX, PREFIX),
            "id": "the_odds_api",
            "doc": {"quota_used": 12},
        }
    ]


async def test_an_unknown_quota_is_not_written_as_zero():
    """`QuotaStatus` is explicit that `None` means unknown, never zero — the free
    `/sports` call reports no usage header at all. Writing a zero there would
    reset a real figure to a fiction on every startup arming call."""
    client = FakeClient()
    await record_quota(client, "the_odds_api", QuotaStatus(used=None), prefix=PREFIX)
    await record_quota(client, "the_odds_api", None, prefix=PREFIX)

    assert client.updates == []


async def test_a_failed_write_does_not_escape():
    """A cosmetic write must never cost a cycle's detection."""
    client = FakeClient(fail=True)
    await record_quota(client, "the_odds_api", QuotaStatus(used=12), prefix=PREFIX)
