"""Context___get_weather."""
from __future__ import annotations

from butler_contracts.models import GetWeatherInput

from .context import Ctx
from .errors import InvalidInput

_NYC = (40.7128, -74.0060)


def get_weather(ctx: Ctx, inp: GetWeatherInput) -> dict:
    if len(inp.date) < 10:
        raise InvalidInput("date must be an ISO date.")
    hh = ctx.household()
    default = (hh.location.lat, hh.location.lon) if hh and hh.location else _NYC
    lat = inp.lat if inp.lat is not None else default[0]
    lon = inp.lon if inp.lon is not None else default[1]
    f = ctx.adapters.weather.forecast(inp.date, lat, lon)
    return {k: f[k] for k in ("summary", "high_c", "low_c", "precip_prob")}
