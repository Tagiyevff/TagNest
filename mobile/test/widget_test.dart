import 'package:flutter_test/flutter_test.dart';
import 'package:tagnest_mobile/main.dart';

void main() {
  testWidgets('shows the pairing screen when no session is stored', (tester) async {
    await tester.pumpWidget(const TagNestApp());
    expect(find.text('TagNest'), findsOneWidget);
    expect(find.text('Pair this phone'), findsOneWidget);
    expect(find.text('COMPUTER ADDRESS'), findsOneWidget);
  });
}
