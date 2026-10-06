"""One tiny real Bedrock call through the LLM wrapper. Opt-in: RUN_BEDROCK_TESTS=1 (uses default AWS credentials)."""
import pytest
from butler_agent.llm import BedrockLLM


@pytest.mark.bedrock
def test_converse_with_the_fast_model_returns_text():
    text = BedrockLLM().ping()
    assert isinstance(text, str) and text.strip()
