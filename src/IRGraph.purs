module IRGraph
    ( IRGraph(..)
    , IRClassData(..)
    , IRType(..)
    , IRUnionRep(..)
    , irUnion_Nothing 
    , irUnion_Null
    , irUnion_Integer
    , irUnion_Double
    , irUnion_Bool
    , irUnion_String
    , unionToSet
    , Entry(..)
    , removeElement
    , emptyGraph
    , followIndex
    , getClassFromGraph
    , lookupOrDefault
    , decomposeTypeSet
    , nullifyNothing
    , isArray
    , isClass
    , isMap
    , setFromType
    , matchingProperties
    , mapClasses
    , combineNames
    , classesInGraph
    , regatherClassNames
    , transformNames
    , filterTypes
    , emptyUnion
    ) where

import Prelude

import Data.Foldable (find, all)
import Data.Int.Bits as Bits
import Data.List (List, (:))
import Data.List as L
import Data.Map (Map)
import Data.Map as M
import Data.Maybe (Maybe(..), fromJust, maybe, fromMaybe)
import Data.Sequence as Seq
import Data.Set (Set)
import Data.Set as S
import Data.String.Util (singular)
import Data.Tuple (Tuple(..))
import Data.Tuple as T
import Partial.Unsafe (unsafePartial)

data Entry
    = NoType
    | Class IRClassData
    | Redirect Int

newtype IRGraph = IRGraph { classes :: Seq.Seq Entry, toplevel :: IRType }

newtype IRClassData = IRClassData { names :: Set String, properties :: Map String IRType }

newtype IRUnionRep = IRUnionRep { primitives :: Int, arrayType :: Maybe IRType, classRef :: Maybe Int, mapType :: Maybe IRType }

irUnion_Nothing = 1
irUnion_Null = 2
irUnion_Integer = 4
irUnion_Double = 8
irUnion_Bool = 16
irUnion_String = 32

data IRType
    = IRNothing
    | IRNull
    | IRInteger
    | IRDouble
    | IRBool
    | IRString
    | IRArray IRType
    | IRClass Int
    | IRMap IRType
    | IRUnion IRUnionRep

derive instance eqEntry :: Eq Entry
derive instance eqIRType :: Eq IRType
derive instance ordIRType :: Ord IRType
derive instance eqIRClassData :: Eq IRClassData
derive instance eqIRUnionRep :: Eq IRUnionRep
derive instance ordIRUnionRep :: Ord IRUnionRep

makeClass :: String -> Map String IRType -> IRClassData
makeClass name properties = IRClassData { names: S.singleton name, properties }

emptyGraph :: IRGraph
emptyGraph = IRGraph { classes: Seq.empty, toplevel: IRNothing }

followIndex :: IRGraph -> Int -> Tuple Int IRClassData
followIndex graph@(IRGraph { classes }) index =
    unsafePartial $
        case fromJust $ Seq.index index classes of
        Class cd -> Tuple index cd
        Redirect i -> followIndex graph i

getClassFromGraph :: IRGraph -> Int -> IRClassData
getClassFromGraph graph index = T.snd $ followIndex graph index

mapClasses :: forall a. (Int -> IRClassData -> a) -> IRGraph -> List a
mapClasses f (IRGraph { classes }) = L.concat $ L.mapWithIndex mapper (L.fromFoldable classes)
    where
        mapper _ NoType = L.Nil
        mapper _ (Redirect _) = L.Nil
        mapper i (Class cd) = (f i cd) : L.Nil

classesInGraph :: IRGraph -> List (Tuple Int IRClassData)
classesInGraph  = mapClasses Tuple

-- FIXME: doesn't really belong here
lookupOrDefault :: forall k v. Ord k => v -> k -> Map k v -> v
lookupOrDefault default key m = maybe default id $ M.lookup key m

-- FIXME: doesn't really belong here
removeElement :: forall a. Ord a => (a -> Boolean) -> S.Set a -> { element :: Maybe a, rest :: S.Set a }
removeElement p s = { element, rest: maybe s (\x -> S.delete x s) element }
    where element = find p s 

isArray :: IRType -> Boolean
isArray (IRArray _) = true
isArray _ = false

isClass :: IRType -> Boolean
isClass (IRClass _) = true
isClass _ = false

isMap :: IRType -> Boolean
isMap (IRMap _) = true
isMap _ = false

-- FIXME: this is horribly inefficient
decomposeTypeSet :: S.Set IRType -> { maybeArray :: Maybe IRType, maybeClass :: Maybe IRType, maybeMap :: Maybe IRType, rest :: S.Set IRType }
decomposeTypeSet s =
    let { element: maybeArray, rest: rest } = removeElement isArray s
        { element: maybeClass, rest: rest } = removeElement isClass rest
        { element: maybeMap, rest: rest } = removeElement isMap rest
    in { maybeArray, maybeClass, maybeMap, rest }

setFromType :: IRType -> S.Set IRType
setFromType IRNothing = S.empty
setFromType x = S.singleton x

nullifyNothing :: IRType -> IRType
nullifyNothing IRNothing = IRNull
nullifyNothing x = x

matchingProperties :: forall v. Eq v => Map String v -> Map String v -> Map String v
matchingProperties ma mb = M.fromFoldable $ L.concatMap getFromB (M.toUnfoldable ma)
    where
        getFromB (Tuple k va) =
            case M.lookup k mb of
            Just vb | va == vb -> Tuple k vb : L.Nil
                    | otherwise -> L.Nil
            Nothing -> L.Nil


isMaybeSubtypeOfMaybe :: IRGraph -> Maybe IRType -> Maybe IRType -> Boolean
isMaybeSubtypeOfMaybe _ Nothing Nothing = true
isMaybeSubtypeOfMaybe graph (Just a) (Just b) = isSubtypeOf graph a b
isMaybeSubtypeOfMaybe _ _ _ = false

isSubclassOf :: IRGraph -> Int -> Int -> Boolean
isSubclassOf graph ia ib =
    let IRClassData { properties: pa } = getClassFromGraph graph ia
        IRClassData { properties: pb } = getClassFromGraph graph ib
    in propertiesAreSubset pa pb
    where
        propertiesAreSubset :: Map String IRType -> Map String IRType -> Boolean
        propertiesAreSubset ma mb = all (isInB mb) (M.toUnfoldable ma :: List _)
        isInB mb (Tuple n ta) = maybe false (isSubtypeOf graph ta) (M.lookup n mb)

-- FIXME: generalize with isMaybeSubtypeOfMaybe
isMaybeSubclassOfMaybe :: IRGraph -> Maybe Int -> Maybe Int -> Boolean
isMaybeSubclassOfMaybe _ Nothing Nothing = true
isMaybeSubclassOfMaybe graph (Just a) (Just b) = isSubclassOf graph a b
isMaybeSubclassOfMaybe _ _ _ = false

isSubtypeOf :: IRGraph ->  IRType -> IRType -> Boolean
isSubtypeOf _ IRNothing _ = true
isSubtypeOf graph (IRUnion a) (IRUnion b) =
    let IRUnionRep { primitives: pa, arrayType: aa, classRef: ca, mapType: ma } = a
        IRUnionRep { primitives: pb, arrayType: ab, classRef: cb, mapType: mb } = a
    in
        (Bits.and pa pb) == pa &&
        isMaybeSubtypeOfMaybe graph aa ab &&
        isMaybeSubtypeOfMaybe graph ma mb &&
        isMaybeSubclassOfMaybe graph ca cb
isSubtypeOf graph (IRArray a) (IRArray b) = isSubtypeOf graph a b
isSubtypeOf graph (IRMap a) (IRMap b) = isSubtypeOf graph a b
isSubtypeOf graph (IRClass ia) (IRClass ib) = isSubclassOf graph ia ib
isSubtypeOf _ a b = a == b

regatherClassNames :: IRGraph -> IRGraph
regatherClassNames graph@(IRGraph { classes, toplevel }) =
    IRGraph { classes: Seq.fromFoldable $ L.mapWithIndex entryMapper $ L.fromFoldable classes, toplevel }
    where
        newNames = combine $ mapClasses gatherFromClassData graph
        entryMapper :: Int -> Entry -> Entry
        entryMapper i entry =
            case entry of
            Class (IRClassData { names, properties }) -> Class $ IRClassData { names: fromMaybe names (M.lookup i newNames), properties}
            _ -> entry
        gatherFromClassData :: Int -> IRClassData -> Map Int (Set String)
        gatherFromClassData _ (IRClassData { properties }) =
            combine $ map (\(Tuple n t) -> gatherFromType n t) (M.toUnfoldable properties :: List _)
        combine :: List (Map Int (Set String)) -> Map Int (Set String)
        combine =
            L.foldr (M.unionWith S.union) M.empty
        gatherFromType :: String -> IRType -> Map Int (Set String)
        gatherFromType name t =
            case t of
            IRClass i -> M.singleton i (S.singleton name)
            IRArray a -> gatherFromType (singular name) a
            IRMap m -> gatherFromType (singular name) m
            IRUnion (IRUnionRep { arrayType, classRef, mapType }) ->
                let fromArray = maybe M.empty (gatherFromType name) arrayType
                    fromMap = maybe M.empty (gatherFromType name) mapType
                    fromClass = maybe M.empty (\i -> gatherFromType name $ IRClass i) classRef
                in
                    combine $ (fromArray : fromMap : fromClass : L.Nil)
            _ -> M.empty

-- FIXME: doesn't really belong here
combineNames :: S.Set String -> String
combineNames s = case L.fromFoldable s of
    L.Nil -> "NONAME"
    n : _ -> n

transformNames :: forall a b. Ord a => (b -> String) -> (String -> String) -> (Set String) -> List (Tuple a b) -> Map a String
transformNames legalize otherize illegalNames names =
    process illegalNames M.empty names
    where
        makeName :: b -> String -> Set String -> String
        makeName name tryName setSoFar =
            if S.member tryName setSoFar then
                makeName name (otherize tryName) setSoFar
            else
                tryName
        process :: (Set String) -> (Map a String) -> (List (Tuple a b)) -> (Map a String)
        process setSoFar mapSoFar l =
            case l of
            L.Nil -> mapSoFar
            (Tuple identifier inputs) : rest ->
                let name = makeName inputs (legalize inputs) setSoFar
                in
                    process (S.insert name setSoFar) (M.insert identifier name mapSoFar) rest

unionToSet :: IRUnionRep -> Set IRType
unionToSet (IRUnionRep { primitives, arrayType, classRef, mapType }) =
    let types1 = addIfSet irUnion_Nothing IRNothing L.Nil
        types2 = addIfSet irUnion_Null IRNull types1
        types3 = addIfSet irUnion_Integer IRInteger types2
        types4 = addIfSet irUnion_Double IRDouble types3
        types5 = addIfSet irUnion_Bool IRBool types4
        types6 = addIfSet irUnion_String IRString types5
        types7 = addIfJust IRArray arrayType types6
        types8 = addIfJust IRClass classRef types7
        types9 = addIfJust IRMap mapType types8
    in
        S.fromFoldable types9
    where
        addIfSet bit t l =
            if (Bits.and bit primitives) == 0 then l else t : l
        addIfJust :: forall a. (a -> IRType) -> Maybe a -> List IRType -> List IRType
        addIfJust c m l =
            case m of
            Just x -> c x : l
            Nothing -> l

filterTypes :: forall a. Ord a => (IRType -> Maybe a) -> IRGraph -> Set a
filterTypes predicate graph@(IRGraph { classes, toplevel }) =
    filterType toplevel <> (S.unions $ mapClasses (\_ cd -> filterClass cd) graph)
    where
        filterClass :: IRClassData -> Set a
        filterClass (IRClassData { properties }) =
            S.unions $ map filterType $ M.values properties
        recurseType t =
            case t of
            IRArray t -> filterType t
            IRMap t -> filterType t
            IRUnion r ->
                S.unions $ S.map filterType $ unionToSet r
            _ -> S.empty
        filterType :: IRType -> Set a
        filterType t =
            let l = recurseType t
            in
                case predicate t of
                Nothing -> l
                Just x -> S.insert x l

emptyUnion :: IRUnionRep
emptyUnion =
    IRUnionRep { primitives: 0, arrayType: Nothing, classRef: Nothing, mapType: Nothing }