import {
    mapMap,
    mapMerge,
    mapUpdateInto,
    setUnionInto,
} from "collection-utils";

import {
    StringTypes,
    stringTypesTypeAttributeKind,
} from "./attributes/StringTypes";
import {
    type TypeAttributes,
    combineTypeAttributes,
    emptyTypeAttributes,
    increaseTypeAttributesDistance,
    makeTypeAttributesInferred,
} from "./attributes/TypeAttributes";
import { assert, assertNever, defined, panic } from "./support/Support";
import {
    type PrimitiveStringTypeKind,
    type PrimitiveTypeKind,
    type Type,
    type TypeKind,
    UnionType,
    isPrimitiveTypeKind,
} from "./Type";
import type { TypeBuilder } from "./Type/TypeBuilder";
import type { TypeRef } from "./Type/TypeRef";
import { matchTypeExhaustive } from "./Type/TypeUtils";

// FIXME: This interface is badly designed.  All the properties
// should use immutable types, and getMemberKinds should be
// implementable using the interface, not be part of it.  That
// means we'll have to expose primitive types, too.
//
// Well, maybe getMemberKinds() is fine as it is.
export interface UnionTypeProvider<TArrayData, TObjectData> {
    readonly arrayData: TArrayData;
    readonly enumCases: ReadonlySet<string>;

    getMemberKinds: () => TypeAttributeMap<TypeKind>;

    readonly lostTypeAttributes: boolean;

    readonly objectData: TObjectData;
}

export type TypeAttributeMap<T extends TypeKind> = Map<T, TypeAttributes>;

type TypeAttributeMapBuilder<T extends TypeKind> = Map<T, TypeAttributes[]>;

function addAttributes(
    accumulatorAttributes: TypeAttributes | undefined,
    newAttributes: TypeAttributes,
): TypeAttributes {
    if (accumulatorAttributes === undefined) return newAttributes;
    return combineTypeAttributes("union", accumulatorAttributes, newAttributes);
}

function setAttributes<T extends TypeKind>(
    attributeMap: TypeAttributeMap<T>,
    kind: T,
    newAttributes: TypeAttributes,
): void {
    attributeMap.set(
        kind,
        addAttributes(attributeMap.get(kind), newAttributes),
    );
}

function addAttributesToBuilder<T extends TypeKind>(
    builder: TypeAttributeMapBuilder<T>,
    kind: T,
    newAttributes: TypeAttributes,
): void {
    let arr = builder.get(kind);
    if (arr === undefined) {
        arr = [];
        builder.set(kind, arr);
    }

    arr.push(newAttributes);
}

function buildTypeAttributeMap<T extends TypeKind>(
    builder: TypeAttributeMapBuilder<T>,
): TypeAttributeMap<T> {
    return mapMap(builder, (arr) => combineTypeAttributes("union", arr));
}

function moveAttributes<T extends TypeKind>(
    map: TypeAttributeMap<T>,
    fromKind: T,
    toKind: T,
): void {
    const fromAttributes = defined(map.get(fromKind));
    map.delete(fromKind);
    setAttributes(map, toKind, fromAttributes);
}

export class UnionAccumulator<TArray, TObject>
    implements UnionTypeProvider<TArray[], TObject[]>
{
    private readonly _nonStringTypeAttributes: TypeAttributeMapBuilder<TypeKind> =
        new Map();

    private readonly _stringTypeAttributes: TypeAttributeMapBuilder<PrimitiveStringTypeKind> =
        new Map();

    public readonly arrayData: TArray[] = [];

    public readonly objectData: TObject[] = [];

    private readonly _enumCases: Set<string> = new Set();

    private _lostTypeAttributes = false;

    public constructor(private readonly _conflateNumbers: boolean) {}

    private have(kind: TypeKind): boolean {
        return (
            this._nonStringTypeAttributes.has(kind) ||
            this._stringTypeAttributes.has(kind as PrimitiveStringTypeKind)
        );
    }

    public addNone(_attributes: TypeAttributes): void {
        // FIXME: Add them to all members?  Or add them to the union, which means we'd have
        // to change getMemberKinds() to also return the attributes for the union itself,
        // or add a new method that does that.
        this._lostTypeAttributes = true;
    }

    public addAny(attributes: TypeAttributes): void {
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "any",
            attributes,
        );
        this._lostTypeAttributes = true;
    }

    public addPrimitive(
        kind: PrimitiveTypeKind,
        attributes: TypeAttributes,
    ): void {
        assert(kind !== "any", "any must be added with addAny");
        addAttributesToBuilder(this._nonStringTypeAttributes, kind, attributes);
    }

    protected addFullStringType(
        attributes: TypeAttributes,
        stringTypes: StringTypes | undefined,
    ): void {
        let stringTypesAttributes: TypeAttributes | undefined = undefined;
        if (stringTypes === undefined) {
            stringTypes =
                stringTypesTypeAttributeKind.tryGetInAttributes(attributes);
        } else {
            stringTypesAttributes =
                stringTypesTypeAttributeKind.makeAttributes(stringTypes);
        }

        if (stringTypes === undefined) {
            stringTypes = StringTypes.unrestricted;
            stringTypesAttributes =
                stringTypesTypeAttributeKind.makeAttributes(stringTypes);
        }

        const maybeEnumAttributes = this._nonStringTypeAttributes.get("enum");
        if (stringTypes.isRestricted) {
            assert(
                maybeEnumAttributes === undefined,
                "We can't add both an enum as well as a restricted string type to a union builder",
            );
        }

        addAttributesToBuilder(
            this._stringTypeAttributes,
            "string",
            attributes,
        );
        if (stringTypesAttributes !== undefined) {
            addAttributesToBuilder(
                this._stringTypeAttributes,
                "string",
                stringTypesAttributes,
            );
        }
    }

    public addStringType(
        kind: PrimitiveStringTypeKind,
        attributes: TypeAttributes,
        stringTypes?: StringTypes,
    ): void {
        if (kind === "string") {
            this.addFullStringType(attributes, stringTypes);
            return;
        }

        addAttributesToBuilder(this._stringTypeAttributes, kind, attributes);
        if (stringTypes !== undefined) {
            addAttributesToBuilder(
                this._stringTypeAttributes,
                kind,
                stringTypesTypeAttributeKind.makeAttributes(stringTypes),
            );
        }
    }

    public addArray(t: TArray, attributes: TypeAttributes): void {
        this.arrayData.push(t);
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "array",
            attributes,
        );
    }

    public addObject(t: TObject, attributes: TypeAttributes): void {
        this.objectData.push(t);
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "object",
            attributes,
        );
    }

    public addEnum(
        cases: ReadonlySet<string>,
        attributes: TypeAttributes,
    ): void {
        const maybeStringAttributes = this._stringTypeAttributes.get("string");
        if (maybeStringAttributes !== undefined) {
            addAttributesToBuilder(
                this._stringTypeAttributes,
                "string",
                attributes,
            );
            return;
        }

        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "enum",
            attributes,
        );
        setUnionInto(this._enumCases, cases);
    }

    public addStringCases(cases: string[], attributes: TypeAttributes): void {
        this.addFullStringType(attributes, StringTypes.fromCases(cases));
    }

    public addStringCase(
        s: string,
        count: number,
        attributes: TypeAttributes,
    ): void {
        this.addFullStringType(attributes, StringTypes.fromCase(s, count));
    }

    public get enumCases(): ReadonlySet<string> {
        return this._enumCases;
    }

    public getMemberKinds(): TypeAttributeMap<TypeKind> {
        assert(
            !(this.have("enum") && this.have("string")),
            "We can't have both strings and enums in the same union",
        );

        const merged = mapMerge(
            buildTypeAttributeMap(this._nonStringTypeAttributes),
            buildTypeAttributeMap(this._stringTypeAttributes),
        );

        if (merged.size === 0) {
            return new Map([
                ["none", emptyTypeAttributes] as [TypeKind, TypeAttributes],
            ]);
        }

        if (this._nonStringTypeAttributes.has("any")) {
            assert(
                this._lostTypeAttributes,
                "This had to be set when we added 'any'",
            );

            const allAttributes = combineTypeAttributes(
                "union",
                Array.from(merged.values()),
            );
            return new Map([
                ["any", allAttributes] as [TypeKind, TypeAttributes],
            ]);
        }

        if (
            this._conflateNumbers &&
            this.have("integer") &&
            this.have("double")
        ) {
            moveAttributes(merged, "integer", "double");
        }

        if (this.have("map")) {
            moveAttributes(merged, "map", "class");
        }

        return merged;
    }

    public get lostTypeAttributes(): boolean {
        return this._lostTypeAttributes;
    }
}

class FauxUnion {
    public getAttributes(): TypeAttributes {
        return emptyTypeAttributes;
    }
}

type UnionOrFaux = UnionType | FauxUnion;

function attributesForTypes(
    types: Iterable<Type>,
): [ReadonlyMap<Type, TypeAttributes>, TypeAttributes] {
    // These two maps are the reverse of each other.  unionsForType is all the unions
    // that are ancestors of that type, when going from one of the given types, only
    // following unions.
    const unionsForType = new Map<Type, Set<UnionOrFaux>>();
    const typesForUnion = new Map<UnionOrFaux, Set<Type>>();

    // All the unions we've seen, starting from types, stopping when we hit non-unions.
    const unions = new Set<UnionType>();
    // All the unions that are equivalent to the single root type.  If more than one type
    // is given, this will be empty.
    let unionsEquivalentToRoot: Set<UnionType> = new Set();
    function traverse(
        t: Type,
        path: UnionOrFaux[],
        isEquivalentToRoot: boolean,
    ): void {
        if (t instanceof UnionType) {
            unions.add(t);
            if (isEquivalentToRoot) {
                unionsEquivalentToRoot = unionsEquivalentToRoot.add(t);
            }

            isEquivalentToRoot = isEquivalentToRoot && t.members.size === 1;
            path.push(t);
            for (const m of t.members) {
                traverse(m, path, isEquivalentToRoot);
            }

            path.pop();
        } else {
            mapUpdateInto(unionsForType, t, (s) =>
                s === undefined ? new Set(path) : setUnionInto(s, path),
            );
            for (const u of path) {
                mapUpdateInto(typesForUnion, u, (s) =>
                    s === undefined ? new Set([t]) : s.add(t),
                );
            }
        }
    }

    const rootPath = [new FauxUnion()];
    const typesArray = Array.from(types);
    for (const t of typesArray) {
        traverse(t, rootPath, typesArray.length === 1);
    }

    const resultAttributes = mapMap(unionsForType, (unionForType, t) => {
        const singleAncestors = Array.from(unionForType).filter(
            (u) => defined(typesForUnion.get(u)).size === 1,
        );
        assert(
            singleAncestors.every((u) => defined(typesForUnion.get(u)).has(t)),
            "We messed up bookkeeping",
        );
        const inheritedAttributes = singleAncestors.map((u) =>
            u.getAttributes(),
        );
        return combineTypeAttributes(
            "union",
            [t.getAttributes()].concat(inheritedAttributes),
        );
    });
    const unionAttributes = Array.from(unions).map((u) => {
        const t = typesForUnion.get(u);
        if (t !== undefined && t.size === 1) {
            return emptyTypeAttributes;
        }

        const attributes = u.getAttributes();
        if (unionsEquivalentToRoot.has(u)) {
            return attributes;
        }

        return makeTypeAttributesInferred(attributes);
    });
    return [resultAttributes, combineTypeAttributes("union", unionAttributes)];
}

// FIXME: Move this to UnifyClasses.ts?
export class TypeRefUnionAccumulator extends UnionAccumulator<
    TypeRef,
    TypeRef
> {
    // There is a method analogous to this in the IntersectionAccumulator.  It might
    // make sense to find a common interface.
    private addType(t: Type, attributes: TypeAttributes): void {
        matchTypeExhaustive(
            t,
            (_noneType) => this.addNone(attributes),
            (_anyType) => this.addAny(attributes),
            (_nullType) => this.addPrimitive("null", attributes),
            (_boolType) => this.addPrimitive("bool", attributes),
            (_integerType) => this.addPrimitive("integer", attributes),
            (_doubleType) => this.addPrimitive("double", attributes),
            (_stringType) => this.addStringType("string", attributes),
            (arrayType) => this.addArray(arrayType.items.typeRef, attributes),
            (classType) => this.addObject(classType.typeRef, attributes),
            (mapType) => this.addObject(mapType.typeRef, attributes),
            (objectType) => this.addObject(objectType.typeRef, attributes),
            // FIXME: We're not carrying counts, so this is not correct if we do enum
            // inference.  JSON Schema input uses this case, however, without enum
            // inference, which is fine, but still a bit ugly.
            (enumType) => this.addEnum(enumType.cases, attributes),
            (_unionType) => {
                return panic(
                    "The unions should have been eliminated in attributesForTypesInUnion",
                );
            },
            (transformedStringType) =>
                this.addStringType(
                    transformedStringType.kind as PrimitiveStringTypeKind,
                    attributes,
                ),
        );
    }

    public addTypes(types: Iterable<Type>): TypeAttributes {
        const [attributesMap, unionAttributes] = attributesForTypes(types);
        for (const [t, attributes] of attributesMap) {
            this.addType(t, attributes);
        }

        return unionAttributes;
    }
}

export abstract class UnionBuilder<
    TBuilder extends TypeBuilder,
    TArrayData,
    TObjectData,
> {
    public constructor(protected readonly typeBuilder: TBuilder) {}

    protected abstract makeObject(
        objects: TObjectData,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef;
    protected abstract makeArray(
        arrays: TArrayData,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef;

    private makeTypeOfKind(
        typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
        kind: TypeKind,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        switch (kind) {
            case "string":
                return this.typeBuilder.getStringType(
                    typeAttributes,
                    undefined,
                    forwardingRef,
                );
            case "enum":
                return this.typeBuilder.getEnumType(
                    typeAttributes,
                    typeProvider.enumCases,
                    forwardingRef,
                );
            case "object":
                return this.makeObject(
                    typeProvider.objectData,
                    typeAttributes,
                    forwardingRef,
                );
            case "array":
                return this.makeArray(
                    typeProvider.arrayData,
                    typeAttributes,
                    forwardingRef,
                );
            default:
                if (isPrimitiveTypeKind(kind)) {
                    return this.typeBuilder.getPrimitiveType(
                        kind,
                        typeAttributes,
                        forwardingRef,
                    );
                }

                if (
                    kind === "union" ||
                    kind === "class" ||
                    kind === "map" ||
                    kind === "intersection"
                ) {
                    return panic(`getMemberKinds() shouldn't return ${kind}`);
                }

                return assertNever(kind);
        }
    }

    public buildUnion(
        typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
        unique: boolean,
        typeAttributes: TypeAttributes,
        forwardingRef?: TypeRef,
    ): TypeRef {
        const kinds = typeProvider.getMemberKinds();

        if (typeProvider.lostTypeAttributes) {
            this.typeBuilder.setLostTypeAttributes();
        }

        // FIXME: We don't reconstitute type attributes here, so it's possible that
        // we get type refs for the wrong graphs if the transformation making rewrite
        // makes unions that have to be unified here.  That's a bug anyway, at least
        // right now, it's just a very bad way of surfacing that error.
        if (kinds.size === 1) {
            const [[kind, memberAttributes]] = Array.from(kinds);
            const allAttributes = combineTypeAttributes(
                "union",
                typeAttributes,
                increaseTypeAttributesDistance(memberAttributes),
            );
            const t = this.makeTypeOfKind(
                typeProvider,
                kind,
                allAttributes,
                forwardingRef,
            );
            return t;
        }

        const union = unique
            ? this.typeBuilder.getUniqueUnionType(
                  typeAttributes,
                  undefined,
                  forwardingRef,
              )
            : undefined;

        const types: TypeRef[] = [];
        for (const [kind, memberAttributes] of kinds) {
            types.push(
                this.makeTypeOfKind(
                    typeProvider,
                    kind,
                    memberAttributes,
                    undefined,
                ),
            );
        }

        const typesSet = new Set(types);
        if (union !== undefined) {
            this.typeBuilder.setSetOperationMembers(union, typesSet);
            return union;
        } else {
            return this.typeBuilder.getUnionType(
                typeAttributes,
                typesSet,
                forwardingRef,
            );
        }
    }
}
