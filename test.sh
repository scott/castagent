#!/bin/bash

# Cast Test Script
# Tests the basic functionality of the Cast CLI

set -e

PROJECT_DIR="/Users/scott/Workspace/castagent"
DEMO_AGENT="demo-agent"
TEST_PORT="10030"

# Use global cast if available, otherwise use local path
if command -v cast &> /dev/null; then
    CAST_CMD="cast"
else
    CAST_CMD="$PROJECT_DIR/typescript/cast-cli/bin/run"
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  Cast - Agent Building & Deployment Platform"
echo "  Test Script"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Using: $CAST_CMD"
echo ""

# Clean up any lingering processes
echo "Cleaning up previous runs..."
pkill -f "cast.runtime" 2>/dev/null || true
pkill -f "cast-cli" 2>/dev/null || true
sleep 1

# Test 1: CLI Help
echo "Test 1: CLI Help"
echo "───────────────────────────────────────────────────────────────"
$CAST_CMD --help
echo "✓ CLI help works"
echo ""

# Test 2: List Agents
echo "Test 2: List Agents"
echo "───────────────────────────────────────────────────────────────"
$CAST_CMD list
echo "✓ List command works"
echo ""

# Test 3: Start Agent in Dev Mode
echo "Test 3: Start Agent (headless mode)"
echo "───────────────────────────────────────────────────────────────"
echo "Starting $DEMO_AGENT on port $TEST_PORT..."

$CAST_CMD dev $DEMO_AGENT --no-tui --port $TEST_PORT > /tmp/cast-dev-test.log 2>&1 &
CLI_PID=$!

# Wait for agent to start
sleep 4

# Test 3a: Get Agent Card
echo ""
echo "Test 3a: Get Agent Card (A2A)"
echo "───────────────────────────────────────────────────────────────"
RESPONSE=$(curl -s -X POST http://localhost:$TEST_PORT/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"agent/card","params":{}}')

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE" | python3 -m json.tool | head -20
  echo "✓ Agent card retrieved"
else
  echo "✗ Failed to get agent card"
  echo "--- Log ---"
  cat /tmp/cast-dev-test.log
fi
echo ""

# Test 3b: Send Message
echo "Test 3b: Send Message (A2A)"
echo "───────────────────────────────────────────────────────────────"
RESPONSE=$(curl -s -X POST http://localhost:$TEST_PORT/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"kind": "text", "text": "What tools do you have?"}],
        "messageId": "test-1"
      }
    }
  }')

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE" | python3 -m json.tool
  echo "✓ Message sent and response received"
else
  echo "✗ Failed to send message"
  echo "--- Log ---"
  cat /tmp/cast-dev-test.log
fi
echo ""

# Cleanup
echo "Cleaning up..."
kill $CLI_PID 2>/dev/null || true
pkill -f "cast.runtime" 2>/dev/null || true
sleep 1

echo "═══════════════════════════════════════════════════════════════"
echo "  Test Complete"
echo "═══════════════════════════════════════════════════════════════"
