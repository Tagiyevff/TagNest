import 'dart:async';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../api.dart';
import '../theme.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.session,
    required this.onSessionLost,
  });

  final Session session;
  final VoidCallback onSessionLost;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late final ApiClient _api = ApiClient(baseUrl: widget.session.baseUrl, token: widget.session.token);
  final TextEditingController _prompt = TextEditingController();
  final FocusNode _promptFocus = FocusNode();
  final ScrollController _scroll = ScrollController();

  RemoteState? _state;
  String? _error;
  bool _loading = true;
  bool _refreshing = false;
  bool _sending = false;
  bool _lost = false;
  int _tab = 0;
  Timer? _poll;
  String _lastSignature = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh(initial: true);
    _startPolling();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _prompt.dispose();
    _promptFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _startPolling();
      _refresh();
    } else if (state == AppLifecycleState.paused) {
      _poll?.cancel();
      _poll = null;
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
  }

  Future<void> _refresh({bool initial = false}) async {
    if (_refreshing || _lost) return;
    _refreshing = true;
    try {
      final next = await _api.fetchState();
      if (!mounted) return;
      final nearBottom = !_scroll.hasClients ||
          _scroll.position.maxScrollExtent - _scroll.position.pixels < 150;
      final signature = _signatureOf(next);
      setState(() {
        _state = next;
        _error = null;
        _loading = false;
      });
      if (signature != _lastSignature) {
        _lastSignature = signature;
        if (nearBottom) _scrollToBottom();
      }
    } on UnauthorizedException {
      _sessionLost();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
      if (initial) {
        // The full error card below offers Retry; no snackbar needed.
      }
    } finally {
      _refreshing = false;
    }
  }

  String _signatureOf(RemoteState state) {
    final conversation = state.conversation;
    final messages = conversation?.messages ?? const <ChatMessageInfo>[];
    final last = messages.isEmpty ? null : messages.last;
    final tool = last?.toolCalls.isNotEmpty == true ? last!.toolCalls.last : null;
    return [
      conversation?.id ?? '',
      messages.length,
      last?.content.length ?? 0,
      last?.toolCalls.length ?? 0,
      tool?.state ?? '',
      tool?.output?.length ?? 0,
      state.task.status,
      state.approval?.id ?? '',
    ].join('|');
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  void _sessionLost() {
    if (_lost) return;
    _lost = true;
    _poll?.cancel();
    SessionStore.clear().then((_) {
      if (mounted) widget.onSessionLost();
    });
  }

  void _notify(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _send() async {
    final text = _prompt.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await _api.send(text, conversationId: _state?.activeConversationId);
      _prompt.clear();
      _promptFocus.unfocus();
      await _refresh();
      _scrollToBottom();
    } on UnauthorizedException {
      _sessionLost();
    } on ApiException catch (error) {
      _notify(error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _cancel() async {
    try {
      await _api.cancel();
      await _refresh();
    } on ApiException catch (error) {
      _notify(error.message);
    }
  }

  Future<void> _approve(bool approved) async {
    final approval = _state?.approval;
    if (approval == null) return;
    try {
      await _api.approve(approval.id, approved);
      await _refresh();
    } on ApiException catch (error) {
      _notify(error.message);
    }
  }

  Future<void> _startLinux() async {
    try {
      await _api.startLinux();
      await _refresh();
    } on ApiException catch (error) {
      _notify(error.message);
    }
  }

  Future<void> _newTask() async {
    Navigator.of(context).pop();
    try {
      await _api.newConversation();
      await _refresh();
      setState(() => _tab = 0);
    } on ApiException catch (error) {
      _notify(error.message);
    }
  }

  Future<void> _selectConversation(String id) async {
    Navigator.of(context).pop();
    try {
      await _api.selectConversation(id);
      await _refresh();
      setState(() => _tab = 0);
    } on ApiException catch (error) {
      _notify(error.message);
    }
  }

  Future<void> _forget() async {
    Navigator.of(context).pop();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Forget this phone?'),
        content: const Text('You will need a new pairing code from the computer to connect again.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Forget')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await _api.forgetDevice();
    } catch (_) {
      // Even if the computer is unreachable, remove the local token.
    }
    await SessionStore.clear();
    if (mounted) widget.onSessionLost();
  }

  void _openMenu() {
    final state = _state;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Tasks', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                if (state == null || state.conversations.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('No tasks yet.', style: TextStyle(color: AppColors.ink3, fontSize: 12)),
                  )
                else
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 300),
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final item in state.conversations)
                          ListTile(
                            contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            selected: item.id == state.activeConversationId,
                            selectedTileColor: Colors.white,
                            title: Text(
                              item.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                            ),
                            subtitle: Text(
                              '${_formatTime(item.updatedAt)} · ${item.messageCount} messages',
                              style: const TextStyle(fontSize: 10.5, color: AppColors.ink3),
                            ),
                            onTap: () => _selectConversation(item.id),
                          ),
                      ],
                    ),
                  ),
                const SizedBox(height: 6),
                FilledButton.tonalIcon(
                  onPressed: _newTask,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('New task'),
                ),
                const SizedBox(height: 8),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  leading: const Icon(Icons.link, size: 18, color: AppColors.ink3),
                  title: Text(
                    widget.session.baseUrl,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11, color: AppColors.ink2),
                  ),
                  subtitle: const Text('Computer address', style: TextStyle(fontSize: 9.5)),
                ),
                OutlinedButton.icon(
                  onPressed: _forget,
                  style: OutlinedButton.styleFrom(foregroundColor: AppColors.err),
                  icon: const Icon(Icons.logout, size: 17),
                  label: const Text('Forget this phone'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    final task = state?.task;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle),
            ),
            const SizedBox(width: 8),
            const Text('TagNest', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.5)),
            const Spacer(),
            _StatusChip(runtime: state?.runtime),
            const SizedBox(width: 4),
          ],
        ),
        actions: [
          IconButton(onPressed: _openMenu, icon: const Icon(Icons.menu, size: 21), tooltip: 'Tasks and connection'),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            _TaskBar(task: task, onStop: _cancel),
            if (_error != null && state != null) _ErrorStrip(message: _error!, onRetry: _refresh),
            Expanded(
              child: IndexedStack(
                index: _tab,
                children: [
                  _buildChat(state),
                  _DesktopPane(
                    baseUrl: widget.session.baseUrl,
                    token: widget.session.token,
                    runtime: state?.runtime,
                    onStart: _startLinux,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline, size: 20), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.desktop_windows_outlined, size: 20), label: 'Desktop'),
        ],
      ),
    );
  }

  Widget _buildChat(RemoteState? state) {
    if (_loading) {
      return const Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)));
    }
    if (state == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off_outlined, size: 30, color: AppColors.ink3),
              const SizedBox(height: 12),
              Text(
                _error ?? 'Could not reach the computer.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.ink2, fontSize: 13, height: 1.45),
              ),
              const SizedBox(height: 14),
              FilledButton.tonal(onPressed: () => _refresh(initial: true), child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    final messages = state.conversation?.messages ?? const <ChatMessageInfo>[];
    final busy = state.task.busy;
    return Column(
      children: [
        Expanded(
          child: messages.isEmpty
              ? _EmptyChat(onPick: (text) {
                  _prompt.text = text;
                  _promptFocus.requestFocus();
                  setState(() {});
                })
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 18),
                  itemCount: messages.length,
                  itemBuilder: (context, index) => _MessageBubble(
                    message: messages[index],
                    working: busy && index == messages.length - 1,
                  ),
                ),
        ),
        if (state.approval != null) _ApprovalCard(approval: state.approval!, onAnswer: _approve),
        _Composer(
          controller: _prompt,
          focusNode: _promptFocus,
          busy: busy,
          sending: _sending,
          onSend: _send,
        ),
      ],
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({this.runtime});

  final RuntimeInfo? runtime;

  @override
  Widget build(BuildContext context) {
    final phase = runtime?.phase ?? 'connecting';
    final running = phase == 'running';
    final failed = phase == 'error';
    final label = running
        ? 'Linux running'
        : failed
            ? 'Linux error'
            : phase == 'stopped'
                ? 'Linux stopped'
                : 'Linux $phase';
    final color = running ? AppColors.ok : failed ? AppColors.err : AppColors.ink2;
    return Container(
      constraints: const BoxConstraints(maxWidth: 130),
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _TaskBar extends StatelessWidget {
  const _TaskBar({required this.task, required this.onStop});

  final TaskInfo? task;
  final Future<void> Function() onStop;

  @override
  Widget build(BuildContext context) {
    final label = _taskLabel(task);
    final busy = task?.busy ?? false;
    return Container(
      height: 32,
      padding: const EdgeInsets.symmetric(horizontal: 17),
      alignment: Alignment.centerLeft,
      child: Row(
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: busy ? AppColors.warn : AppColors.ink3,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11, color: AppColors.ink2),
            ),
          ),
          if (busy)
            TextButton(
              onPressed: () => onStop(),
              style: TextButton.styleFrom(
                foregroundColor: AppColors.err,
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                textStyle: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600),
              ),
              child: const Text('Stop'),
            ),
        ],
      ),
    );
  }

  String _taskLabel(TaskInfo? task) {
    if (task == null) return 'Ready';
    final activity = task.activity == null || task.activity!.isEmpty ? '' : ' · ${task.activity}';
    switch (task.status) {
      case 'planning':
        return 'Planning$activity';
      case 'running':
        return 'Working$activity';
      case 'waiting-approval':
        return 'Waiting for your approval';
      case 'cancelling':
        return 'Stopping…';
      case 'done':
        return 'Done';
      case 'error':
        return 'The task failed';
      case 'cancelled':
        return 'Stopped';
      default:
        return 'Ready';
    }
  }
}

class _ErrorStrip extends StatelessWidget {
  const _ErrorStrip({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 0, 14, 4),
      padding: const EdgeInsets.fromLTRB(10, 3, 6, 3),
      decoration: BoxDecoration(
        color: AppColors.err.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.err, fontSize: 10.5),
            ),
          ),
          TextButton(onPressed: () => onRetry(), child: const Text('Retry', style: TextStyle(fontSize: 10.5))),
        ],
      ),
    );
  }
}

class _EmptyChat extends StatelessWidget {
  const _EmptyChat({required this.onPick});

  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    const suggestions = [
      'Create a Python script in ~/workspace that prints real system information',
      'Build a small website in ~/workspace and serve it on port 8080',
      'Open the terminal and show me the kernel version',
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 26, 18, 18),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.7),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.line),
            ),
            child: const Icon(Icons.auto_awesome_outlined, size: 17, color: AppColors.ink2),
          ),
        ),
        const SizedBox(height: 14),
        const Text(
          'A real Linux desktop,\nready for work.',
          style: TextStyle(fontSize: 23, height: 1.18, fontWeight: FontWeight.w700, letterSpacing: -0.7),
        ),
        const SizedBox(height: 8),
        const Text(
          'Ask for anything that needs a computer. The AI works inside the Linux machine on your PC, and you can '
          'watch or take over on the Desktop tab.',
          style: TextStyle(color: AppColors.ink2, fontSize: 12.5, height: 1.55),
        ),
        const SizedBox(height: 20),
        for (final suggestion in suggestions)
          Padding(
            padding: const EdgeInsets.only(bottom: 7),
            child: Material(
              color: Colors.white.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(11),
              child: InkWell(
                borderRadius: BorderRadius.circular(11),
                onTap: () => onPick(suggestion),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    border: Border.all(color: AppColors.line),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          suggestion,
                          style: const TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.ink2),
                        ),
                      ),
                      const Icon(Icons.north_east, size: 13, color: AppColors.ink3),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.working});

  final ChatMessageInfo message;
  final bool working;

  @override
  Widget build(BuildContext context) {
    final user = message.fromUser;
    final content = message.content.trim();
    final hasBody = content.isNotEmpty || message.error != null || message.toolCalls.isNotEmpty;
    if (!hasBody && !working) return const SizedBox.shrink();
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 560),
        margin: const EdgeInsets.only(top: 12),
        child: Column(
          crossAxisAlignment: user ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 4, right: 4, bottom: 4),
              child: Text(
                user ? 'YOU' : 'TAGNEST',
                style: const TextStyle(
                  fontSize: 8.5,
                  color: AppColors.ink3,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.8,
                ),
              ),
            ),
            if (content.isNotEmpty || message.error != null || (working && !user))
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: user ? const Color(0xFFDDE6EB) : AppColors.surface,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(14),
                    topRight: const Radius.circular(14),
                    bottomLeft: Radius.circular(user ? 14 : 4),
                    bottomRight: Radius.circular(user ? 4 : 14),
                  ),
                  border: Border.all(color: AppColors.line),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (content.isNotEmpty)
                      SelectableText(
                        content,
                        style: const TextStyle(fontSize: 13.5, height: 1.5, color: AppColors.ink),
                      ),
                    if (message.error != null)
                      Padding(
                        padding: EdgeInsets.only(top: content.isEmpty ? 0 : 8),
                        child: Text(
                          message.error!,
                          style: const TextStyle(fontSize: 11.5, height: 1.45, color: AppColors.err),
                        ),
                      ),
                    if (working && !user && content.isEmpty && message.error == null)
                      const _TypingDots(),
                  ],
                ),
              ),
            for (final call in message.toolCalls) _ToolCard(call: call),
            if (message.cancelled)
              const Padding(
                padding: EdgeInsets.only(top: 3, left: 4),
                child: Text('Stopped by you', style: TextStyle(fontSize: 9.5, color: AppColors.ink3)),
              ),
          ],
        ),
      ),
    );
  }
}

class _TypingDots extends StatelessWidget {
  const _TypingDots();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      height: 12,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Dot(),
          SizedBox(width: 3),
          _Dot(),
          SizedBox(width: 3),
          _Dot(),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 5,
      height: 5,
      decoration: BoxDecoration(color: AppColors.ink3.withValues(alpha: 0.6), shape: BoxShape.circle),
    );
  }
}

class _ToolCard extends StatelessWidget {
  const _ToolCard({required this.call});

  final ToolCallInfo call;

  Color get _stateColor {
    switch (call.state) {
      case 'ok':
        return AppColors.ok;
      case 'error':
      case 'denied':
        return AppColors.err;
      case 'running':
      case 'awaiting-approval':
        return AppColors.warn;
      default:
        return AppColors.ink3;
    }
  }

  String get _stateLabel {
    switch (call.state) {
      case 'running':
        return 'Running';
      case 'awaiting-approval':
        return 'Waiting';
      case 'ok':
        return 'Done';
      case 'error':
        return 'Failed';
      case 'denied':
        return 'Denied';
      case 'cancelled':
        return 'Cancelled';
      default:
        return call.state;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 5),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          key: PageStorageKey(call.id),
          tilePadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 9),
          minTileHeight: 36,
          dense: true,
          title: Row(
            children: [
              Container(width: 6, height: 6, decoration: BoxDecoration(color: _stateColor, shape: BoxShape.circle)),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  call.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: AppColors.ink),
                ),
              ),
              const SizedBox(width: 6),
              Text(_stateLabel, style: TextStyle(fontSize: 8.5, color: _stateColor, fontWeight: FontWeight.w600)),
            ],
          ),
          children: [
            if (call.summary != null && call.summary!.isNotEmpty)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Text(call.summary!, style: const TextStyle(fontSize: 10, color: AppColors.ink3)),
                ),
              ),
            if (call.command != null && call.command!.isNotEmpty)
              _CodeBlock(text: '\$ ${call.command!}'),
            if (call.output != null && call.output!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: _CodeBlock(text: call.output!.length > 8000 ? call.output!.substring(0, 8000) : call.output!),
              ),
            if (call.exitCode != null)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('Exit code: ${call.exitCode}', style: const TextStyle(fontSize: 9.5, color: AppColors.ink3)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(maxHeight: 190),
      padding: const EdgeInsets.all(7),
      decoration: BoxDecoration(color: AppColors.ink.withValues(alpha: 0.05), borderRadius: BorderRadius.circular(7)),
      child: SingleChildScrollView(
        child: SelectableText(
          text,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 9.5,
            height: 1.45,
            color: AppColors.ink2,
          ),
        ),
      ),
    );
  }
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval, required this.onAnswer});

  final ApprovalInfo approval;
  final Future<void> Function(bool approved) onAnswer;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 0, 14, 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFBF5E9),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.warn.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            approval.title,
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.ink),
          ),
          if (approval.reason.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              approval.reason,
              style: const TextStyle(fontSize: 10.5, height: 1.45, color: AppColors.ink2),
            ),
          ],
          if (approval.command != null && approval.command!.isNotEmpty) ...[
            const SizedBox(height: 7),
            _CodeBlock(text: approval.command!),
          ],
          const SizedBox(height: 9),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: () => onAnswer(true),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 38)),
                  child: const Text('Allow once', style: TextStyle(fontSize: 12)),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => onAnswer(false),
                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 38)),
                  child: const Text('Deny', style: TextStyle(fontSize: 12)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.focusNode,
    required this.busy,
    required this.sending,
    required this.onSend,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool busy;
  final bool sending;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 9),
      decoration: const BoxDecoration(
        color: Color(0xEFF0F3F5),
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                focusNode: focusNode,
                minLines: 1,
                maxLines: 5,
                textCapitalization: TextCapitalization.sentences,
                keyboardType: TextInputType.multiline,
                style: const TextStyle(fontSize: 16),
                decoration: const InputDecoration(
                  hintText: 'Ask TagNest to build something in Linux…',
                  contentPadding: EdgeInsets.symmetric(horizontal: 13, vertical: 11),
                ),
              ),
            ),
            const SizedBox(width: 8),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: controller,
              builder: (context, value, _) {
                final enabled = value.text.trim().isNotEmpty && !busy && !sending;
                return IconButton.filled(
                  onPressed: enabled ? () => onSend() : null,
                  style: IconButton.styleFrom(
                    backgroundColor: AppColors.accent,
                    disabledBackgroundColor: AppColors.ink3.withValues(alpha: 0.25),
                    minimumSize: const Size(44, 44),
                    maximumSize: const Size(44, 44),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                  ),
                  icon: sending
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Icon(Icons.arrow_upward, size: 19, color: Color(0xFFF3F6F8)),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _DesktopPane extends StatefulWidget {
  const _DesktopPane({
    required this.baseUrl,
    required this.token,
    required this.runtime,
    required this.onStart,
  });

  final String baseUrl;
  final String token;
  final RuntimeInfo? runtime;
  final Future<void> Function() onStart;

  @override
  State<_DesktopPane> createState() => _DesktopPaneState();
}

class _DesktopPaneState extends State<_DesktopPane> {
  WebViewController? _controller;
  String? _error;
  bool _starting = false;

  bool get _running => widget.runtime?.running ?? false;

  @override
  void initState() {
    super.initState();
    _setup();
  }

  @override
  void didUpdateWidget(covariant _DesktopPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    final wasRunning = oldWidget.runtime?.running ?? false;
    if (_running && !wasRunning) _controller?.reload();
  }

  Future<void> _setup() async {
    final uri = Uri.parse(widget.baseUrl);
    try {
      await WebViewCookieManager().setCookie(
        WebViewCookie(name: 'tagnest_remote', value: widget.token, domain: uri.host, path: '/'),
      );
    } catch (_) {
      // The controller can still work if the cookie store refused the value;
      // the page will show its own pairing message in that case.
    }
    try {
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(AppColors.desktop)
        ..setNavigationDelegate(
          NavigationDelegate(
            onNavigationRequest: (request) {
              if (request.url.startsWith(widget.baseUrl) || request.url.startsWith('about:')) {
                return NavigationDecision.navigate;
              }
              return NavigationDecision.prevent;
            },
            onWebResourceError: (error) {
              if (error.isForMainFrame == true && mounted) {
                setState(() => _error = error.description);
              }
            },
          ),
        );
      await controller.loadRequest(Uri.parse('${widget.baseUrl}/desktop'));
      if (!mounted) return;
      setState(() => _controller = controller);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  Future<void> _start() async {
    setState(() => _starting = true);
    try {
      await widget.onStart();
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final runtime = widget.runtime;
    final showOverlay = !_running || _error != null;
    final starting = runtime?.phase == 'starting' ||
        runtime?.phase == 'preparing' ||
        runtime?.phase == 'downloading-image' ||
        runtime?.phase == 'creating-disk' ||
        runtime?.phase == 'provisioning' ||
        runtime?.phase == 'connecting';
    final failed = runtime?.phase == 'error';
    return Container(
      color: AppColors.desktop,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (_controller != null)
            WebViewWidget(controller: _controller!)
          else
            const Center(child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white54)),
          if (showOverlay)
            Positioned.fill(
              child: Container(
                color: AppColors.desktop.withValues(alpha: 0.78),
                padding: const EdgeInsets.all(20),
                alignment: Alignment.center,
                child: Container(
                  constraints: const BoxConstraints(maxWidth: 340),
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 30, offset: Offset(0, 12))],
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Linux desktop',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, letterSpacing: -0.3),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        _error ?? runtime?.error ?? runtime?.message ?? 'Linux is not running on the computer.',
                        style: const TextStyle(fontSize: 11.5, height: 1.5, color: AppColors.ink2),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          if (!failed || runtime == null)
                            FilledButton(
                              onPressed: _starting || starting ? null : _start,
                              style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                              child: Text(_starting || starting ? 'Starting…' : 'Start Linux'),
                            ),
                          if (failed) ...[
                            FilledButton(
                              onPressed: _starting ? null : _start,
                              style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                              child: const Text('Try again'),
                            ),
                          ],
                          const SizedBox(width: 8),
                          if (_controller != null)
                            OutlinedButton(
                              onPressed: () {
                                setState(() => _error = null);
                                _controller?.reload();
                              },
                              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                              child: const Text('Reconnect'),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

String _formatTime(int milliseconds) {
  if (milliseconds <= 0) return '';
  final date = DateTime.fromMillisecondsSinceEpoch(milliseconds);
  final now = DateTime.now();
  final sameDay = date.year == now.year && date.month == now.month && date.day == now.day;
  final hour = date.hour.toString().padLeft(2, '0');
  final minute = date.minute.toString().padLeft(2, '0');
  return sameDay ? '$hour:$minute' : '${date.day}.${date.month} $hour:$minute';
}
