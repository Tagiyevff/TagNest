import 'package:flutter_test/flutter_test.dart';
import 'package:tagnest_mobile/api.dart';

void main() {
  group('normalizeServerInput', () {
    test('adds https when the scheme is missing', () {
      expect(normalizeServerInput('example.trycloudflare.com'), 'https://example.trycloudflare.com');
    });

    test('keeps an explicit http address and drops a trailing slash', () {
      expect(normalizeServerInput('http://192.168.1.20:47821/'), 'http://192.168.1.20:47821');
    });

    test('rejects an empty address', () {
      expect(() => normalizeServerInput('   '), throwsA(isA<ApiException>()));
    });

    test('rejects a path because the app appends its own API paths', () {
      expect(() => normalizeServerInput('https://example.test/tagnest'), throwsA(isA<ApiException>()));
    });
  });

  test('parses the remote state used by the home screen', () {
    final state = RemoteState.fromJson({
      'version': '0.7.0',
      'runtime': {'phase': 'running', 'message': 'Linux is running'},
      'task': {'status': 'running', 'activity': 'Installing a package'},
      'conversations': [
        {'id': 'c1', 'title': 'Build a page', 'updatedAt': 10, 'messageCount': 2},
      ],
      'activeConversationId': 'c1',
      'conversation': {
        'id': 'c1',
        'title': 'Build a page',
        'updatedAt': 10,
        'messages': [
          {
            'id': 'm1',
            'role': 'assistant',
            'content': 'Done',
            'toolCalls': [
              {'id': 't1', 'name': 'run_command', 'title': 'Run command', 'state': 'ok', 'exitCode': 0},
            ],
          },
        ],
      },
    });

    expect(state.version, '0.7.0');
    expect(state.runtime.running, isTrue);
    expect(state.task.busy, isTrue);
    expect(state.conversation?.messages.single.toolCalls.single.exitCode, 0);
    expect(state.conversations.single.messageCount, 2);
  });
}
