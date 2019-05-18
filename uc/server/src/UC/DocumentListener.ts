import * as fs from 'fs';
import * as path from 'path';

import { performance } from 'perf_hooks';
import { Diagnostic, Range, Position } from 'vscode-languageserver-types';
import URI from 'vscode-uri';

import { BehaviorSubject } from 'rxjs';

import { ANTLRErrorListener, RecognitionException, Recognizer, Token, CommonTokenStream, ParserRuleContext } from 'antlr4ts';
import { ErrorNode } from 'antlr4ts/tree/ErrorNode';
import { ParseTreeWalker } from 'antlr4ts/tree/ParseTreeWalker';

import { UCGrammarListener } from '../antlr/UCGrammarListener';
import * as UCParser from '../antlr/UCGrammarParser';
import { UCGrammarLexer } from '../antlr/UCGrammarLexer';
import { CaseInsensitiveStream } from './Parser/CaseInsensitiveStream';
import { connection } from '../server';

import { rangeFromBounds, rangeFromBound } from './helpers';
import { ISymbolContainer } from './Symbols/ISymbolContainer';
import {
	ISymbol, UCClassSymbol, UCConstSymbol, UCDefaultPropertiesBlock,
	UCEnumMemberSymbol, UCEnumSymbol, UCMethodSymbol,
	UCLocalSymbol, UCObjectSymbol, UCPackage, SymbolsTable, UCParamSymbol,
	UCPropertySymbol, UCScriptStructSymbol, UCStateSymbol,
	UCStructSymbol, UCSymbol, UCSymbolReference,
	UCTypeSymbol,
	UCDocumentClassSymbol, UCReplicationBlock
} from './Symbols';
import { UCTypeKind } from './Symbols/TypeKind';
import { IDiagnosticNode, SyntaxErrorNode } from './diagnostics/diagnostics';
import { UCExpressionVisitor } from './ExpressionVisitor';
import { UCStatementVisitor } from './StatementVisitor';
import { ISymbolReference } from './Symbols/ISymbol';
import { UCBlock } from './Statements';

export const ExpressionVisitor = new UCExpressionVisitor();
export const StatementVisitor = new UCStatementVisitor();

const PathPackageMap = new Map<string, UCPackage>();
function getPackageByUri(uri: string): UCPackage {
	const dir = path.parse(uri).dir;
	let packageSymbol: UCPackage = PathPackageMap.get(dir);
	if (packageSymbol) {
		return packageSymbol;
	}

	const dirs = dir.split('/');
	for (let i = dirs.length - 1; i >= 0; -- i) {
		if (i > 0 && dirs[i].toLowerCase() === 'classes') {
			const packageName = dirs[i - 1];

			packageSymbol = SymbolsTable.getSymbol(packageName.toLowerCase()) as UCPackage;
			if (packageSymbol) {
				PathPackageMap.set(dir, packageSymbol);
				return packageSymbol;
			}

			packageSymbol = new UCPackage(packageName);
			PathPackageMap.set(dir, packageSymbol);
			SymbolsTable.addSymbol(packageSymbol);
			return packageSymbol;
		}
	}
	return SymbolsTable;
}

const ClassNameToDocumentMap: Map<string, UCDocument> = new Map<string, UCDocument>();
export function getDocumentByUri(uri: string): UCDocument {
	let document: UCDocument = ClassNameToDocumentMap.get(uri);
	if (document) {
		return document;
	}

	const packageTable = getPackageByUri(uri);

	document = new UCDocument(packageTable, uri);
	ClassNameToDocumentMap.set(uri, document);
	return document;
}

export function getDocumentById(qualifiedId: string): UCDocument {
	const uri = getUriById(qualifiedId);
	if (!uri) {
		return undefined;
	}

	const document: UCDocument = getDocumentByUri(uri);
	return document;
}

export function indexDocument(document: UCDocument, text?: string) {
	try {
		document.invalidate();
		document.parse(text);

		// send diagnostics before linking begins so that we can report syntax errors early on
		const diagnostics = document.getNodes();
		connection.sendDiagnostics({
			uri: document.uri,
			diagnostics
		});

		if (document.class) {
			document.link();
		} else {
			console.warn("Indexed a document with no class!", document.uri);
		}
	} catch (err) {
		console.error(`An error occurred during the indexation of document ${document.uri}`, err);
		return undefined;
	}
}

export const ClassNameToFilePathMap$ = new BehaviorSubject(new Map<string, string>());

export function getUriById(qualifiedClassId: string): string | undefined {
	const filePath: string = ClassNameToFilePathMap$.getValue().get(qualifiedClassId);
	return filePath ? URI.file(filePath).toString() : undefined;
}

const IndexedReferences = new Map<string, Set<ISymbolReference>>();

export function addIndexedReference(qualifiedId: string, ref: ISymbolReference) {
	const indexedRefs = getIndexedReferences(qualifiedId);
	indexedRefs.add(ref);

	IndexedReferences.set(qualifiedId, indexedRefs);
}

export function getIndexedReferences(qualifiedId: string): Set<ISymbolReference> {
	return IndexedReferences.get(qualifiedId) || new Set<ISymbolReference>();
}

export function unsetIndexedReferences(qualifiedId: string, refs: Set<ISymbolReference>) {
	const indexedRefs = IndexedReferences.get(qualifiedId);
	if (!indexedRefs) {
		return;
	}

	refs.forEach(ref => indexedRefs.delete(ref));

	if (indexedRefs.size === 0) {
		IndexedReferences.delete(qualifiedId);
	}
}

const EnumMemberMap = new Map<string, UCEnumMemberSymbol>();

export function getEnumMember(enumMember: string): UCEnumMemberSymbol {
	return EnumMemberMap.get(enumMember);
}

export function setEnumMember(enumMember: UCEnumMemberSymbol) {
	EnumMemberMap.set(enumMember.getId(), enumMember);
}

export class UCDocument implements UCGrammarListener, ANTLRErrorListener<Token> {
	public name: string;

	public nodes: IDiagnosticNode[] = [];
	public tokenStream: CommonTokenStream;

	public class?: UCClassSymbol;
	public indexReferencesMade = new Map<string, Set<ISymbolReference>>();

	private context?: UCStructSymbol[]; // FIXME: Type

	constructor(public classPackage: UCPackage, public readonly uri: string) {
		this.name = path.basename(uri, '.uc');
	}

	push(newContext: UCStructSymbol) {
		this.context.push(newContext);
	}

	pop() {
		this.context.pop();
	}

	get(): ISymbolContainer<ISymbol> {
		return this.context.length > 0
			? this.context[this.context.length - 1]
			: this.classPackage;
	}

	declare(symbol: UCSymbol) {
		const context = this.get();
		context.addSymbol(symbol);
	}

	parse(text?: string) {
		const startParsing = performance.now();
		connection.console.log('parsing document ' + this.name);

		const lexer = new UCGrammarLexer(new CaseInsensitiveStream(text || this.readText()));
		lexer.removeErrorListeners();
		lexer.addErrorListener(this as ANTLRErrorListener<number>);

		const stream = this.tokenStream = new CommonTokenStream(lexer);

		const parser = new UCParser.UCGrammarParser(stream);
		parser.removeErrorListeners();
		parser.addErrorListener(this);

		connection.console.log(this.name + ': parsing time ' + (performance.now() - startParsing));

		const startWalking = performance.now();
		try {
			const programCtx = parser.program();
			ParseTreeWalker.DEFAULT.walk(this, programCtx);
		} catch (err) {
			console.error('Error walking document', this.uri, err);
		}
		connection.console.log(this.name + ': Walking time ' + (performance.now() - startWalking));
	}

	readText(): string {
		const filePath = URI.parse(this.uri).fsPath;
		const text = fs.readFileSync(filePath).toString();
		return text;
	}

	link() {
		const start = performance.now();
		this.class!.index(this, this.class);
		connection.console.log(this.name + ': linking time ' + (performance.now() - start));
	}

	invalidate() {
		delete this.class;
		this.nodes = []; // clear

		// Clear all the indexed references that we have made.
		for (let [key, value] of this.indexReferencesMade) {
			unsetIndexedReferences(key, value);
		}

		this.indexReferencesMade.clear();
	}

	analyze(): Diagnostic[] {
		if (!this.class) {
			return undefined;
		}

		const start = performance.now();
		this.class!.analyze(this, this.class);
		connection.console.log(this.name + ': analyzing time ' + (performance.now() - start));
		return this.getNodes();
	}

	getNodes() {
		return this.nodes
			.map(node => {
				return Diagnostic.create(
					node.getRange(),
					node.toString(),
					undefined,
					undefined,
					'unrealscript'
				);
			});
	}

	getSymbolAtPos(position: Position): ISymbol {
		return this.class && this.class.getSymbolAtPos(position);
	}

	syntaxError(_recognizer: Recognizer<Token, any>,
		offendingSymbol: Token | undefined,
		_line: number,
		_charPositionInLine: number,
		msg: string,
		error: RecognitionException | undefined
	) {
		let range: Range;
		if (error && error.context instanceof ParserRuleContext) {
			range = rangeFromBounds(error.context.start, offendingSymbol);
		} else {
			range = rangeFromBound(offendingSymbol);
		}
		const node = new SyntaxErrorNode(range, msg);
		this.nodes.push(node);
	}

	visitErrorNode(errNode: ErrorNode) {
		const node = new SyntaxErrorNode(rangeFromBound(errNode.symbol), '(ANTLR Node Error) ' + errNode.text);
		this.nodes.push(node);
	}

	visitExtendsClause(extendsCtx: UCParser.ExtendsClauseContext | UCParser.WithinClauseContext, _type: UCTypeKind): UCTypeSymbol {
		const idNode = extendsCtx.qualifiedIdentifier();
		return new UCTypeSymbol(idNode.text, rangeFromBounds(idNode.start, idNode.stop), undefined, _type);
	}

	enterProgram(ctx: UCParser.ProgramContext) {
		this.context = [];
	}

	exitProgram(ctx: UCParser.ProgramContext) {
		this.context = undefined;
	}

	enterClassDecl(ctx: UCParser.ClassDeclContext) {
		const classIdNode = ctx.identifier();
		const classSymbol = new UCDocumentClassSymbol(classIdNode.text, rangeFromBound(classIdNode.start), rangeFromBounds(ctx.start, ctx.stop));
		classSymbol.context = ctx;
		this.class = classSymbol; // Important!, must be assigned before further parsing.

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			classSymbol.extendsType = this.visitExtendsClause(extendsNode, UCTypeKind.Class);
			classSymbol.extendsType.outer = classSymbol;
		}

		const withinNode = ctx.withinClause();
		if (withinNode) {
			classSymbol.withinType = this.visitExtendsClause(withinNode, UCTypeKind.Class);
			classSymbol.withinType.outer = classSymbol;
		}

		const modifierNodes = ctx.classModifier();
		for (let modifierNode of modifierNodes) {
			const idNode = modifierNode.identifier();
			const modifierArgumentNodes = modifierNode.modifierArguments();
			switch (idNode.text.toLowerCase()) {
				case 'dependson': {
					if (modifierArgumentNodes) {
						if (!classSymbol.dependsOnTypes) {
							classSymbol.dependsOnTypes = [];
						}
						for (let valueNode of modifierArgumentNodes.modifierValue()) {
							const typeSymbol = new UCTypeSymbol(valueNode.text, rangeFromBounds(valueNode.start, valueNode.stop), undefined, UCTypeKind.Class);
							classSymbol.dependsOnTypes.push(typeSymbol);
						}
					}
				}
				case 'implements': {
					if (modifierArgumentNodes) {
						if (!classSymbol.implementsTypes) {
							classSymbol.implementsTypes = [];
						}
						for (let valueNode of modifierArgumentNodes.modifierValue()) {
							const typeSymbol = new UCTypeSymbol(valueNode.text, rangeFromBounds(valueNode.start, valueNode.stop), undefined, UCTypeKind.Class);
							classSymbol.implementsTypes.push(typeSymbol);
						}
					}
				}
			}
		}

		this.declare(classSymbol); // push to package
		this.push(classSymbol);
	}

 	enterConstDecl(ctx: UCParser.ConstDeclContext) {
		const idNode = ctx.identifier();
		if (!idNode) {
			return;
		}

		const constSymbol = new UCConstSymbol(idNode.text, rangeFromBound(idNode.start), rangeFromBounds(ctx.start, ctx.stop));
		constSymbol.context = ctx;

		// Ensure that all constant declarations are always declared as a top level field (i.e. class)
		this.class.addSymbol(constSymbol);

		const valueNode = ctx.constValue();
		if (valueNode) {
			constSymbol.value = valueNode.text;
		}
	}

	enterEnumDecl(ctx: UCParser.EnumDeclContext) {
		const idNode = ctx.identifier();
		if (!idNode) {
			return;
		}

		const enumSymbol = new UCEnumSymbol(idNode.text, rangeFromBound(idNode.start), rangeFromBounds(ctx.start, ctx.stop));
		enumSymbol.context = ctx;
		this.declare(enumSymbol);
		this.push(enumSymbol);

		var count = 0;
		const memberNodes = ctx.enumMember();
		for (const memberNode of memberNodes) {
			const range = rangeFromBound(memberNode.start);
			const memberIdNode = memberNode.identifier();
			const memberSymbol = new UCEnumMemberSymbol(memberIdNode.text, range, range);
			this.declare(memberSymbol);
			// HACK: overwrite define() outer let.
			memberSymbol.outer = enumSymbol;
			memberSymbol.value = count ++;

			setEnumMember(memberSymbol);
		}
	}

	exitEnumDecl(ctx: UCParser.EnumDeclContext) {
		this.pop();
	}

	enterStructDecl(ctx: UCParser.StructDeclContext) {
		const idNode = ctx.identifier();
		if (!idNode) {
			return;
		}

		const structSymbol = new UCScriptStructSymbol(idNode.text, rangeFromBound(idNode.start), rangeFromBounds(ctx.start, ctx.stop));
		structSymbol.context = ctx;

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			structSymbol.extendsType = this.visitExtendsClause(extendsNode, UCTypeKind.Struct);
		}

		this.declare(structSymbol);
		this.push(structSymbol);
	}

	exitStructDecl(ctx: UCParser.StructDeclContext) {
		this.pop();
	}

	private visitClassType(classTypeNode: UCParser.ClassTypeContext): UCTypeSymbol {
		const typeNode = classTypeNode.type();
		return new UCTypeSymbol(typeNode.text,rangeFromBounds(typeNode.start, typeNode.stop), undefined, UCTypeKind.Class);
	}

	private visitTypeDecl(typeDeclNode: UCParser.TypeDeclContext): UCTypeSymbol {
		let typeIdText: string;
		let typeIdRange: Range;
		let innerTypeSymbol: UCTypeSymbol;

		const typeNode = typeDeclNode.type();
		if (typeNode) {
			typeIdText = typeNode.text;
			typeIdRange = rangeFromBounds(typeNode.start, typeNode.stop);
		} else {
			const classTypeNode = typeDeclNode.classType();
			if (classTypeNode) {
				innerTypeSymbol = this.visitClassType(classTypeNode);
				typeIdText = 'Class';
				typeIdRange = rangeFromBound(classTypeNode.start);
			} else if (typeDeclNode instanceof UCParser.TypeDeclContext) {
				const arrayTypeNode = typeDeclNode.arrayType();
				if (arrayTypeNode) {
					innerTypeSymbol = this.visitInlinedDeclTypes(arrayTypeNode.inlinedDeclTypes());
					typeIdText = 'Array';
					typeIdRange = rangeFromBound(arrayTypeNode.start);
				}
			}
		}

		const typeSymbol = new UCTypeSymbol(typeIdText, typeIdRange, rangeFromBounds(typeDeclNode.start, typeDeclNode.stop));
		typeSymbol.outer = this.get() as UCStructSymbol;
		typeSymbol.baseType = innerTypeSymbol;
		if (innerTypeSymbol) {
			innerTypeSymbol.outer = typeSymbol;
		}
		return typeSymbol;
	}

	private visitInlinedDeclTypes(inlinedTypeCtx: UCParser.InlinedDeclTypesContext): UCTypeSymbol {
		const structDeclNode = inlinedTypeCtx.structDecl();
		if (structDeclNode) {
			const structIdNode = structDeclNode.identifier();
			return new UCTypeSymbol(structIdNode.text, rangeFromBounds(structIdNode.start, structIdNode.stop), undefined, UCTypeKind.Struct);
		}

		const enumDeclNode = inlinedTypeCtx.enumDecl();
		if (enumDeclNode) {
			const enumIdNode = enumDeclNode.identifier();
			return new UCTypeSymbol(enumIdNode.text, rangeFromBounds(enumIdNode.start, enumIdNode.stop), undefined, UCTypeKind.Enum);
		}
		return this.visitTypeDecl(inlinedTypeCtx.typeDecl());
	}

	enterVarDecl(ctx: UCParser.VarDeclContext) {
		const declTypeNode = ctx.inlinedDeclTypes();
		if (!declTypeNode) {
			return;
		}

		const typeSymbol = this.visitInlinedDeclTypes(declTypeNode);

		const varNodes = ctx.variable();
		for (const variableNode of varNodes) {
			const varIdNode = variableNode.identifier();

			const property = new UCPropertySymbol(varIdNode.start.text, rangeFromBound(varIdNode.start),
				// Stop at varCtx instead of ctx for multiple variable declarations.
				rangeFromBounds(ctx.start, variableNode.stop)
			);
			property.context = variableNode;
			property.type = typeSymbol;
			const arrayDimNode = variableNode.arrayDim();
			if (arrayDimNode) {
				property.arrayDim = arrayDimNode.text;
			}
			this.declare(property);

			if (typeSymbol) {
				typeSymbol.outer = property.outer; // FIXME: Assign to current context instead.
			}
		}
	}

	enterReplicationBlock(ctx: UCParser.ReplicationBlockContext) {
		const nameNode = ctx.kwREPLICATION();
		const replicationBlock = new UCReplicationBlock(nameNode.text, rangeFromBound(nameNode.start), rangeFromBounds(ctx.start, ctx.stop));
		replicationBlock.context = ctx;

		this.declare(replicationBlock);

		const statementNodes = ctx.replicationStatement();
		if (!statementNodes) {
			return;
		}

		const block = new UCBlock(rangeFromBounds(ctx.start, ctx.stop));
		block.statements = Array(statementNodes.length);
		for (var i = 0; i < statementNodes.length; ++ i) {
			const statement = statementNodes[i].accept(StatementVisitor);
			block.statements[i] = statement;

			const idNodes = statementNodes[i].identifier();
			if (idNodes) for (const idNode of idNodes) {
				const identifier = idNode.text;
				const symbolRef = new UCSymbolReference(identifier, rangeFromBound(idNode.start));
				symbolRef.outer = this.class;
				replicationBlock.symbolRefs.set(identifier.toLowerCase(), symbolRef);
			}
		}
		replicationBlock.block = block;
	}

	enterFunctionDecl(ctx: UCParser.FunctionDeclContext) {
		const nameNode = ctx.functionName();
		if (!nameNode) {
			return;
		}

		const methodSymbol = new UCMethodSymbol(
			// We need start and stop for functions with special symbols (which are made of multiple tokens)
			nameNode.text, rangeFromBounds(nameNode.start, nameNode.stop),
			rangeFromBounds(ctx.start, ctx.stop)
		);
		methodSymbol.context = ctx;
		this.declare(methodSymbol);
		this.push(methodSymbol);

		const returnTypeNode = ctx.returnType();
		if (returnTypeNode) {
			methodSymbol.returnType = this.visitTypeDecl(returnTypeNode.typeDecl());
		}

		const paramsNode = ctx.parameters();
		if (paramsNode) {
			methodSymbol.params = [];
			const paramNodes = paramsNode.paramDecl();
			for (const paramNode of paramNodes) {
				if (!paramNode) {
					break;
				}

				const variableNode = paramNode.variable();
				const propIdNode = variableNode.identifier();
				if (!propIdNode) {
					continue;
				}

				const propSymbol = new UCParamSymbol(
					propIdNode.text, rangeFromBound(propIdNode.start),
					rangeFromBounds(paramNode.start, paramNode.stop)
				);

				const propTypeNode = paramNode.typeDecl();
				propSymbol.type = this.visitTypeDecl(propTypeNode);

				const arrayDimNode = variableNode.arrayDim();
				if (arrayDimNode) {
					propSymbol.arrayDim = arrayDimNode.text;
				}

				methodSymbol.params.push(propSymbol);
				this.declare(propSymbol);
			}
		}

		const bodyNode = ctx.functionBody();
		if (bodyNode) {
			const localNodes = bodyNode.localDecl();
			if (localNodes) this.visitLocals(bodyNode, localNodes);

			const statementNodes = bodyNode.statement();
			if (statementNodes) {
				methodSymbol.block = this.visitStatements(bodyNode, statementNodes);
			}
		}
	}

	visitLocals(ctx: ParserRuleContext, nodes: UCParser.LocalDeclContext[]) {
		for (const localNode of nodes) {
			if (!localNode) {
				break;
			}

			const propTypeNode = localNode.typeDecl();
			const typeSymbol = this.visitTypeDecl(propTypeNode);

			const varNodes = localNode.variable();
			for (const variableNode of varNodes) {
				const propIdNode = variableNode.identifier();
				if (!propIdNode) {
					continue;
				}

				const propSymbol = new UCLocalSymbol(
					propIdNode.text, rangeFromBound(propIdNode.start),
					// Stop at varCtx instead of localCtx for multiple variable declarations.
					rangeFromBounds(localNode.start, variableNode.stop)
				);
				propSymbol.type = typeSymbol;
				const arrayDimNode = variableNode.arrayDim();
				if (arrayDimNode) {
					propSymbol.arrayDim = arrayDimNode.text;
				}
				this.declare(propSymbol);
			}
		}
	}

	visitStatements(ctx: ParserRuleContext, nodes: UCParser.StatementContext[]) {
		const block = new UCBlock(rangeFromBounds(ctx.start, ctx.stop));
		block.statements = Array(nodes.length);
		for (var i = 0; i < nodes.length; ++ i) {
			const statement = nodes[i].accept(StatementVisitor);
			block.statements[i] = statement;
		}
		return block;
	}

	exitFunctionDecl(ctx: UCParser.FunctionDeclContext) {
		this.pop();
	}

	enterStateDecl(ctx: UCParser.StateDeclContext) {
		const stateIdNode = ctx.identifier();
		if (!stateIdNode) {
			return;
		}

		const stateSymbol = new UCStateSymbol(stateIdNode.text, rangeFromBound(stateIdNode.start), rangeFromBounds(ctx.start, ctx.stop));
		stateSymbol.context = ctx;

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			stateSymbol.extendsType = this.visitExtendsClause(extendsNode, UCTypeKind.State);
		}

		const localNodes = ctx.localDecl();
		if (localNodes) this.visitLocals(ctx, localNodes);

		this.declare(stateSymbol);
		this.push(stateSymbol);

		const statementNodes = ctx.statement();
		if (statementNodes) {
			stateSymbol.block = this.visitStatements(ctx, statementNodes);
		}
	}

	exitStateDecl(ctx: UCParser.StateDeclContext) {
		this.pop();
	}

	enterStructDefaultPropertiesBlock(ctx: UCParser.StructDefaultPropertiesBlockContext) {
		const nameNode = ctx.kwSTRUCTDEFAULTPROPERTIES();
		const defaultsBlock = new UCDefaultPropertiesBlock(
			nameNode.text, rangeFromBound(nameNode.start),
			rangeFromBounds(ctx.start, ctx.stop)
		);
		defaultsBlock.context = ctx;

		this.declare(defaultsBlock);
		this.push(defaultsBlock);
	}

	enterDefaultPropertiesBlock(ctx: UCParser.DefaultPropertiesBlockContext) {
		const nameNode = ctx.kwDEFAULTPROPERTIES();
		const defaultsBlock = new UCDefaultPropertiesBlock(
			nameNode.text, rangeFromBound(nameNode.start),
			rangeFromBounds(ctx.start, ctx.stop)
		);
		defaultsBlock.context = ctx;

		this.declare(defaultsBlock);
		this.push(defaultsBlock);
	}

	enterObjectDecl(ctx: UCParser.ObjectDeclContext) {
		const objectSymbol = new UCObjectSymbol(
			'', rangeFromBound(ctx.start),
			rangeFromBounds(ctx.start, ctx.stop)
		);
		objectSymbol.context = ctx;

		this.declare(objectSymbol);
		this.push(objectSymbol);
	}

	enterDefaultVariable(ctx: UCParser.DefaultVariableContext) {
		const idNode = ctx.defaultId();
		const symbolRef = new UCSymbolReference(idNode.text, rangeFromBound(ctx.start));

		const context = this.get() as UCObjectSymbol;
		symbolRef.outer = context;

		const propNameLC = idNode.text.toLowerCase();
		switch (propNameLC) {
			case 'name': {
				// TODO: change name
			}

			case 'class': {
				const typeSymbol = new UCTypeSymbol(
					symbolRef.getName(), rangeFromBounds(idNode.start, idNode.stop), undefined,
					UCTypeKind.Class
				);
				typeSymbol.outer = context;
				context.extendsType = typeSymbol;
			}
		}
		context.symbolRefs.set(propNameLC, symbolRef);

		const valueNode = ctx.defaultValue();
		if (valueNode) {
			const literal = valueNode.defaultLiteral();
			const structCtx = literal.structLiteral();
			if (structCtx) {
				const subSymbol = new UCObjectSymbol(
					// Use the same name as the assigned var's name.
					idNode.text, rangeFromBound(structCtx.start),
					rangeFromBounds(structCtx.start, structCtx.stop)
				);
				this.push(subSymbol);
			}
		}
	}

	exitDefaultVariable(ctx: UCParser.DefaultVariableContext) {
		const valueNode = ctx.defaultValue();
		if (valueNode && valueNode.defaultLiteral().structLiteral()) {
			this.pop();
		}
	}

	exitObjectDecl(ctx: UCParser.ObjectDeclContext) {
		this.pop();
	}

	exitStructDefaultPropertiesBlock(ctx: UCParser.StructDefaultPropertiesBlockContext) {
		this.pop();
	}

	exitDefaultPropertiesBlock(ctx: UCParser.DefaultPropertiesBlockContext) {
		this.pop();
	}
}