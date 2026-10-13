"""JSON-safe conversion: NaN/inf -> null, numpy -> python, Enum -> value. Python ints (money) stay exact."""
from __future__ import annotations

import math
from enum import Enum

import numpy as np


def json_safe(o):
    if isinstance(o, dict):
        return {str(k): json_safe(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [json_safe(v) for v in o]
    if isinstance(o, np.ndarray):
        return json_safe(o.tolist())
    if isinstance(o, (np.floating,)):
        o = float(o)
    elif isinstance(o, (np.integer,)):
        return int(o)
    elif isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, Enum):
        return o.value
    return o
