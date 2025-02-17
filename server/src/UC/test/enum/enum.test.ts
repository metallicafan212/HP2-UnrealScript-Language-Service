import { expect } from 'chai';

import { rangeToString } from '../../diagnostics/diagnostic';
import { DocumentAnalyzer } from '../../diagnostics/documentAnalyzer';
import { UCDefaultAssignmentExpression, UCDefaultElementAccessExpression } from '../../expressions';
import { queueIndexDocument } from '../../indexer';
import { toName } from '../../name';
import { NAME_DEFAULTPROPERTIES, NAME_ENUMCOUNT } from '../../names';
import {
    addHashedSymbol,
    IntrinsicObject,
    removeHashedSymbol,
    UCDefaultPropertiesBlock,
    UCEnumMemberSymbol,
    UCEnumSymbol,
    UCMethodSymbol,
    UCPropertySymbol,
    UCSymbolKind,
} from '../../Symbols';
import { assertBinaryOperatorExpressionMemberSymbol, assertExpressionStatement } from '../utils/codeAsserts';
import { usingDocuments } from '../utils/utils';

describe('Enum usage', () => {
    usingDocuments(__dirname, ['EnumTest.uc'], ([testDocument]) => {
        addHashedSymbol(IntrinsicObject);
        queueIndexDocument(testDocument);
        removeHashedSymbol(IntrinsicObject);

        const documentClass = testDocument.class;
        const enumTestSymbol = documentClass.getSymbol<UCEnumSymbol>(toName('EEnumTest'));
        expect(enumTestSymbol)
            .to.not.be.undefined;

        it('Enum EEnumTest is declared', () => {
            expect(enumTestSymbol)
                .to.not.be.undefined;
            expect(enumTestSymbol.getSymbol(toName('ET_None')))
                .to.not.be.undefined;
            expect(enumTestSymbol.getSymbol(toName('ET_Other')))
                .to.not.be.undefined;
        });

        it('Intrinsic EnumCount', () => {
            expect(enumTestSymbol.getSymbol<UCEnumMemberSymbol>(NAME_ENUMCOUNT))
                .to.not.be.undefined;
            expect(enumTestSymbol.getSymbol<UCEnumMemberSymbol>(NAME_ENUMCOUNT).value)
                .to.equal(2);
        });

        // Not yet globally indexed
        // TODO: Implement globally to enable support for Enum'EEnumTest';
        // it('Enum EEnumTest is indexed', () => {
        //     const globalSymbol = ObjectsTable.getSymbol<UCEnumSymbol>(toName('EEnumTest'), UCSymbolKind.Enum);
        //     expect(globalSymbol).to.not.be.undefined;
        // });

        it('Usage in Properties', () => {
            expect(documentClass.getSymbol<UCPropertySymbol>(toName('MyEnumProperty'))
                .getType().getRef())
                .to.equal(enumTestSymbol);
            expect(documentClass.getSymbol<UCPropertySymbol>(toName('MyEnumBasedDimProperty'))
                .arrayDimRef.getRef())
                .to.equal(enumTestSymbol);
            // TODO: Support
            // expect(documentClass.getSymbol<UCPropertySymbol>(toName('MyQualifiedEnumBasedDimProperty')).arrayDimRef.getRef().outer).to.equal(enumSymbol);
        });

        it('Usage in Methods', () => {
            const symbol = documentClass.getSymbol<UCMethodSymbol>(toName('EnumHintTest'));
            expect(symbol, 'symbol')
                .to.not.be.undefined;

            expect(symbol.returnValue.getType().getRef())
                .is.equal(enumTestSymbol);

            expect(symbol.params[0].getType().getRef())
                .to.equal(enumTestSymbol);
            expect(symbol.params[0].defaultExpression.getType().getRef())
                .to.equal(enumTestSymbol.getSymbol(toName('ET_Max')));
        });

        it('Usage in DefaultProperties', () => {
            const symbol = documentClass.getSymbol<UCDefaultPropertiesBlock>(
                NAME_DEFAULTPROPERTIES,
                UCSymbolKind.DefaultPropertiesBlock);
            expect(symbol, 'symbol')
                .to.not.be.undefined;

            expect(symbol.block, 'symbol block')
                .to.not.be.undefined;

            const block = symbol.block;

            // MyEnumProperty=ET_None
            assertBinaryOperatorExpressionMemberSymbol(
                assertExpressionStatement(block.statements[0]).expression,
                documentClass.getSymbol(toName('MyEnumProperty')),
                enumTestSymbol.getSymbol(toName('ET_None')));

            // MyEnumBasedDimProperty(ET_None)=ET_None
            assertBinaryOperatorExpressionMemberSymbol(
                assertExpressionStatement(block.statements[1]).expression,
                documentClass.getSymbol(toName('MyEnumBasedDimProperty')),
                enumTestSymbol.getSymbol(toName('ET_None')));

            expect(((assertExpressionStatement(block.statements[1]).expression as UCDefaultAssignmentExpression).left as UCDefaultElementAccessExpression)
                .argument.getMemberSymbol())
                .to.equal(enumTestSymbol.getSymbol(toName('ET_None')));
        });

        it('should have no problems', () => {
            const diagnoser = new DocumentAnalyzer(testDocument);
            documentClass.accept(diagnoser);
            const diagnostics = diagnoser.getDiagnostics();
            const msg = diagnostics.toDiagnostic()
                .map(d => `${rangeToString(d.range)}: ${d.message}`)
                .join('\n');
            expect(diagnostics.count(), msg)
                .is.equal(0);
        });
    });
});
