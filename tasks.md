# ClaudeBridge - Task Backlog

## Current Sprint: Phase 0 - POC

### Done (Phase 0)
- [x] **P0** Verify POC hook server works with actual Claude Code hooks

### Todo

#### Phase 1: Basic Approval Bridge
- [ ] **P1** Create Telegram bot skeleton with grammY
- [ ] **P1** Implement inline approval buttons in Telegram
- [ ] **P1** Connect hook server to Telegram bot
- [ ] **P1** Add timeout handling for approval requests
- [ ] **P2** Add request ID correlation

#### Phase 2: Front-end AI Integration
- [ ] **P1** Design multi-model provider abstraction (borrow from OpenClaw)
- [ ] **P1** Implement API key secure storage
- [ ] **P1** Front-end AI message interpretation
- [ ] **P2** Auto-approve rules engine
- [ ] **P2** Escalation logic for destructive operations

#### Phase 3: Session Management
- [ ] **P1** Implement pty-based Claude Code spawning
- [ ] **P1** Rolling buffer for session output (last N lines)
- [ ] **P2** `/context` command implementation
- [ ] **P2** Multiple concurrent session support
- [ ] **P3** Session persistence across restarts

#### Phase 4: Polish & Robustness
- [ ] **P2** Telegram reconnection/retry logic (borrow from OpenClaw)
- [ ] **P2** SQLite state persistence
- [ ] **P2** Comprehensive error handling
- [ ] **P3** Structured logging
- [ ] **P3** Configuration management

### Done
- [x] **P0** Create project structure
- [x] **P0** Initialize TypeScript project
- [x] **P0** Create POC hook server
- [x] **P0** Create hook test script
- [x] **P0** Create Claude Code hook configuration example

## Notes

### POC Success Criteria
1. Start Claude Code with hook configured
2. Trigger a permission prompt
3. Hook fires, sends request to local server
4. Server logs the request and waits
5. Manually send approval response
6. Claude Code receives approval and proceeds

### OpenClaw Components to Borrow
- Multi-model provider abstraction
- API key management/storage
- Telegram grammY setup (reconnection, retry, rate limiting)
