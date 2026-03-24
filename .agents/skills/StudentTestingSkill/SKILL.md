---
name: StudentTestingSkill
description: A skill for managing and generating student tests for the Student Testing Application.
---

# StudentTestingSkill

This skill provides instructions and tools for creating and managing tests in the Student Testing Application.

## Capabilities
- **Create Test**: Generate a JSON structure for a new test.
- **Add Question**: Append questions of various types to an existing test.
- **Export Test**: Prepare a test for the server.

## Test JSON Structure
Tests are stored in `tests/` directory as JSON files.

```json
{
  "title": "Sample Quiz",
  "questions": [
    {
      "id": 1,
      "type": "single",
      "text": "What is 2+2?",
      "options": ["3", "4", "5"],
      "answer": "4"
    },
    {
      "id": 2,
      "type": "multiple",
      "text": "Select prime numbers",
      "options": ["2", "3", "4", "5"],
      "answer": ["2", "3", "5"]
    },
    {
      "id": 3,
      "type": "text",
      "text": "Capital of France?",
      "answer": "Paris"
    },
    {
      "id": 4,
      "type": "matching",
      "text": "Match the following:",
      "pairs": {
        "A": "1",
        "B": "2"
      }
    }
  ]
}
```

## How to use
When the user asks to "create a test on [topic]", use this skill's structure to generate the JSON file in the `tests/` folder.
