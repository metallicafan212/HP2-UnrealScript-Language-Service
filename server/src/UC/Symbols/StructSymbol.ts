import { CompletionItemKind, Position, SymbolKind } from 'vscode-languageserver-types';

import { UCDocument } from '../document';
import { intersectsWith } from '../helpers';
import { Name } from '../name';
import { UCBlock } from '../statements';
import { SymbolWalker } from '../symbolWalker';
import {
    Identifier, isMethodSymbol, isStateSymbol, ISymbol, ISymbolContainer, ITypeSymbol,
    UCFieldSymbol, UCTypeFlags
} from './';

export class UCStructSymbol extends UCFieldSymbol implements ISymbolContainer<ISymbol> {
	public extendsType?: ITypeSymbol;
	public super?: UCStructSymbol;
	public children?: UCFieldSymbol;
	public block?: UCBlock;
    public labels?: { [key: number]: Identifier };

	getKind(): SymbolKind {
		return SymbolKind.Namespace;
	}

	getCompletionItemKind(): CompletionItemKind {
		return CompletionItemKind.Module;
	}

	getCompletionSymbols<C extends ISymbol>(document: UCDocument, _context: string, type?: UCTypeFlags) {
		const symbols: ISymbol[] = [];
		for (let child = this.children; child; child = child.next) {
			if (typeof type !== 'undefined' && (child.getTypeFlags() & type) === 0) {
				continue;
			}
			if (child.acceptCompletion(document, this)) {
				symbols.push(child);
			}
		}

		let parent: UCStructSymbol | undefined = this.super ?? this.outer as UCStructSymbol;
		for (; parent; parent = parent.super ?? parent.outer as UCStructSymbol) {
			for (let child = parent.children; child; child = child.next) {
				if (typeof type !== 'undefined' && (child.getTypeFlags() & type) === 0) {
					continue;
				}
				if (child.acceptCompletion(document, this)) {
					symbols.push(child);
				}
			}
		}
		return symbols as C[];
	}

	getCompletionContext(position: Position) {
		for (let symbol = this.children; symbol; symbol = symbol.next) {
			if (intersectsWith(symbol.getRange(), position)) {
				const context = symbol.getCompletionContext(position);
				if (context) {
					return context;
				}
			}
		}
		return this;
	}

	getContainedSymbolAtPos(position: Position) {
		return this.extendsType?.getSymbolAtPos(position)
			?? this.block?.getSymbolAtPos(position)
			?? this.getChildSymbolAtPos(position);
	}

	getChildSymbolAtPos(position: Position) {
		for (let child = this.children; child; child = child.next) {
			const innerSymbol = child.getSymbolAtPos(position);
			if (innerSymbol) {
				return innerSymbol;
			}
		}
		return undefined;
	}

    addLabel(label: Identifier): void {
        if (typeof this.labels === 'undefined') {
            this.labels = Object.create(null);
        }
        this.labels![label.name.hash] = label;
    }

    childrenCount(): number {
        let l = 0;
        for (let child = this.children; child; child = child.next) {
            ++l;
        }
        return l;
    }

	addSymbol(symbol: UCFieldSymbol): number | undefined {
		symbol.outer = this;
		symbol.next = this.children;
		symbol.containingStruct = this;
		this.children = symbol;
		// No key
		return undefined;
	}

    removeSymbol(symbol: UCFieldSymbol) {
        if (this.children === symbol) {
            this.children = symbol.next;
            symbol.next = undefined;
            return;
        }

        for (let child = this.children; child; child = child.next) {
			if (child.next === symbol) {
                child.next = symbol.next;
                break;
			}
		}
    }

	getSymbol<T extends UCFieldSymbol>(id: Name, kind?: UCTypeFlags): T | undefined {
		for (let child = this.children; child; child = child.next) {
			if (child.id.name === id) {
				if (kind !== undefined && (child.getTypeFlags() & kind) === 0) {
					continue;
				}
				return child as T;
			}
		}
		return undefined;
	}

    findSymbolPredicate<T extends UCFieldSymbol>(predicate: (symbol: UCFieldSymbol) => boolean): T | undefined {
		for (let child = this.children; child; child = child.next) {
            if (predicate(child)) {
                return child as T;
            }
		}
		return undefined;
	}


	findSuperSymbol<T extends UCFieldSymbol>(id: Name, kind?: UCTypeFlags): T | undefined {
		return this.getSymbol<T>(id, kind) ?? this.super?.findSuperSymbol(id, kind);
	}

	index(document: UCDocument, context: UCStructSymbol) {
		super.index(document, context);
		if (this.extendsType) {
			this.extendsType.index(document, context);
			// Ensure that we don't overwrite super assignment from our descendant class.
			if (!this.super) {
				this.super = this.extendsType.getRef<UCStructSymbol>();
			}
		}

		if (this.children) for (let child: undefined | UCFieldSymbol = this.children; child; child = child.next) {
			try {
				child.index(document, this);
			} catch (err) {
				console.error(`Encountered an error while indexing '${child.getPath()}': ${err}`);
			}
		}
	}

	accept<Result>(visitor: SymbolWalker<Result>): Result | void {
		return visitor.visitStruct(this);
	}
}

/**
 * Looks up the @struct's hierarchy for a matching @id
 */
export function findSuperStruct(context: UCStructSymbol, id: Name): UCStructSymbol | undefined {
	for (let other = context.super; other; other = other.super) {
		if (other.id.name === id) {
			return other;
		}
	}
	return undefined;
}

/**
 * Searches a @param context for a symbol with a matching @param id along with a @param predicate,
 * - if there was no predicate match, the last id matched symbol will be returned instead.
 */
export function findSymbol<T extends UCFieldSymbol>(context: UCStructSymbol, id: Name, predicate: (symbol: UCFieldSymbol) => boolean): T | undefined {
	let scope: UCStructSymbol | undefined = isMethodSymbol(context)
        ? context.outer as UCStructSymbol
        : context;
	if (scope && isStateSymbol(scope)) {
		scope = scope.outer as UCStructSymbol;
	}

	let bestChild: T | undefined = undefined;
	for (; scope; scope = scope.super) {
		for (let child = scope.children; child; child = child.next) {
			if (child.id.name === id) {
				if (predicate(child)) {
					return child as T;
				}
				bestChild = child as T;
			}
		}
	}
	return bestChild;
}