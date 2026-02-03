# ClaudeBridge - Task Backlog

## Current Sprint: Phase 1 - Telegram Approval Bridge

### Done (Phase 0)
- [x] **P0** Verify POC hook server works with actual Claude Code hooks

### Done (Phase 1)
- [x] **P1** Create Telegram bot skeleton with grammY
- [x] **P1** Implement inline approval buttons in Telegram
- [x] **P1** Connect hook server to Telegram bot
- [x] **P1** Add timeout handling for approval requests
- [x] **P2** Add request ID correlation

### Done (Security Hardening)
- [x] **P0** Telegram bot user authentication (ALLOWED_CHAT_IDS + first-claim)
- [x] **P0** Config file permission hardening (0700 dir, 0600 file)
- [x] **P0** Shell script injection fix (node -e blocks use process.env)
- [x] **P1** Add `--` before task arg in session-manager (flag injection prevention)
- [x] **P1** Input length limit on /spawn (2000 chars)
- [x] **P1** Bot token format validation in install scripts
- [x] **P1** LOG_LEVEL support with logger utility (suppress sensitive data)
- [x] **P1** .gitignore: add config.json rule
- [x] **P1** LICENSE file (MIT)
- [x] **P1** README: Security section, ALLOWED_CHAT_IDS and LOG_LEVEL docs
- [x] **P1** package.json: repository field, author

### In Progress
- [~] **P1** Test full Telegram approval flow with real Claude Code

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
