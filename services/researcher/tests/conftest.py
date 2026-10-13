import pytest

from researcher.data.synthetic import SyntheticParams, generate


@pytest.fixture(scope="session")
def ds_small():
    return generate(SyntheticParams(seed=3, n_bars=1500))


@pytest.fixture(scope="session")
def ds_rug():
    # a seed where at least one meme asset is rugged and delisted inside the sample
    return generate(SyntheticParams(seed=2, n_bars=3000))
